import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";

const CALLBACK_TYPE = "IMAGE_EVIDENCE" as const;

export type CallbackStatus = "PENDING" | "ACK_ACCEPTED" | "RESOLVING" | "UNCONFIRMED" | "RESOLVED";

export type ResolvedOutcomeType =
  | "UPLOADED"
  | "REJECTED"
  | "UPLOAD_FAILED"
  | "OBJECT_INVALID"
  | "OBJECT_MISSING"
  | "TIMEOUT";

export interface EvidenceCallbackRecord {
  caseId: string;
  callbackType: typeof CALLBACK_TYPE;
  commandId: string;
  imageId: string;
  expectedS3Key: string;
  deviceId: string;
  recipientId: string;
  reason: "LOCAL_VISUAL_ANOMALY" | "SENSOR_ANOMALY";
  captureMode: "BUFFERED" | "CURRENT";
  taskToken: string;
  status: CallbackStatus;
  commandExpiresAt: string;
  resolutionLeaseId?: string;
  resolutionLeaseExpiresAt?: number;
  resolvedOutcomeType?: ResolvedOutcomeType;
  resolvedReason?: string;
  createdAt: string;
  updatedAt: string;
  ttlEpochSeconds: number;
}

export interface NewCommandInput {
  caseId: string;
  deviceId: string;
  recipientId: string;
  reason: "LOCAL_VISUAL_ANOMALY" | "SENSOR_ANOMALY";
  captureMode: "BUFFERED" | "CURRENT";
  commandTimeoutSeconds: number;
  ttlBufferSeconds: number;
}

export type PrepareCommandResult =
  | {
      action: "PUBLISH";
      commandId: string;
      imageId: string;
      s3Key: string;
      commandExpiresAt: string;
    }
  | {
      action: "RESOLVE_IMMEDIATELY";
      outcomeType: ResolvedOutcomeType;
      reason?: string;
      s3Key: string;
      imageId: string;
    }
  | { action: "NOOP" };

/**
 * Idempotencia de RequestEvidenceUpload por caso/fase (PK=caseId,
 * SK=callbackType fijo), no por commandId generado en cada intento: un
 * reintento reutiliza commandId/imageId/s3Key existentes.
 *
 * Reglas de seguridad al reintentar (aprobadas explicitamente):
 * - status PENDING/ACK_ACCEPTED: unico caso que refresca taskToken (nunca
 *   pisa status: si era ACK_ACCEPTED, sigue siendo ACK_ACCEPTED).
 * - status RESOLVED: no se toca la tabla; el llamador debe resolver ESTE
 *   token localmente con el resultado ya conocido (RESOLVE_IMMEDIATELY).
 * - status RESOLVING/UNCONFIRMED: no se toca nada (NOOP); el timeout de
 *   Step Functions absorbe el caso de forma segura si nadie mas resuelve.
 */
export async function prepareUploadCommand(
  tableName: string,
  input: NewCommandInput,
  taskToken: string,
  mintS3Key: (recipientId: string, caseId: string, imageId: string) => string,
): Promise<PrepareCommandResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const commandExpiresAt = new Date(now.getTime() + input.commandTimeoutSeconds * 1000).toISOString();
  const ttlEpochSeconds =
    Math.floor(now.getTime() / 1000) + input.commandTimeoutSeconds + input.ttlBufferSeconds;

  const commandId = randomUUID();
  const imageId = randomUUID();
  const s3Key = mintS3Key(input.recipientId, input.caseId, imageId);

  const newItem: EvidenceCallbackRecord = {
    caseId: input.caseId,
    callbackType: CALLBACK_TYPE,
    commandId,
    imageId,
    expectedS3Key: s3Key,
    deviceId: input.deviceId,
    recipientId: input.recipientId,
    reason: input.reason,
    captureMode: input.captureMode,
    taskToken,
    status: "PENDING",
    commandExpiresAt,
    createdAt: nowIso,
    updatedAt: nowIso,
    ttlEpochSeconds,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: newItem,
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
    return { action: "PUBLISH", commandId, imageId, s3Key, commandExpiresAt };
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
  }

  const existing = await getCallback(tableName, input.caseId);
  if (!existing) {
    // Carrera muy improbable: perdimos la condicion pero una lectura
    // eventualmente consistente aun no ve el item. Se propaga como error
    // transitorio para que Step Functions reintente la Task completa.
    throw new Error(`No se pudo leer EvidenceCallbacks recien creado para caseId=${input.caseId}`);
  }

  // Guarda de consistencia interna (no es COMMAND_CONFLICT del lado MQTT,
  // que es responsabilidad de la Pi; esto detecta un bug propio si la
  // misma anomalia derivara reason/captureMode distintos entre intentos).
  if (existing.reason !== input.reason || existing.captureMode !== input.captureMode) {
    throw new Error(
      `Inconsistencia interna en EvidenceCallbacks para caseId=${input.caseId}: ` +
        `reason/captureMode no coinciden con el registro existente`,
    );
  }

  if (existing.status === "PENDING" || existing.status === "ACK_ACCEPTED") {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { caseId: input.caseId, callbackType: CALLBACK_TYPE },
          UpdateExpression: "SET taskToken = :token, updatedAt = :now",
          ConditionExpression: "commandId = :commandId AND (#status = :pending OR #status = :ackAccepted)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":token": taskToken,
            ":now": nowIso,
            ":commandId": existing.commandId,
            ":pending": "PENDING",
            ":ackAccepted": "ACK_ACCEPTED",
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
      // Alguien avanzo el estado justo entre nuestra lectura y esta
      // actualizacion (p. ej. adquirio el lease de resolucion). No tocar
      // nada mas: el token de esta invocacion queda sin resolver y el
      // timeout de Step Functions lo absorbe de forma segura.
      return { action: "NOOP" };
    }
    return {
      action: "PUBLISH",
      commandId: existing.commandId,
      imageId: existing.imageId,
      s3Key: existing.expectedS3Key,
      commandExpiresAt: existing.commandExpiresAt,
    };
  }

  if (existing.status === "RESOLVED") {
    return {
      action: "RESOLVE_IMMEDIATELY",
      outcomeType: existing.resolvedOutcomeType ?? "TIMEOUT",
      reason: existing.resolvedReason,
      // Necesarios para que un exito tardio (UPLOADED) pueda reconstruir el
      // mismo output que produce el camino normal de callback (ver
      // requestEvidenceUploadFn.ts): la Task de Step Functions que mapea a
      // AVAILABLE lee $.evidenceUploadResult.s3Key/imageId sin importar por
      // cual de los dos caminos se resolvio.
      s3Key: existing.expectedS3Key,
      imageId: existing.imageId,
    };
  }

  // RESOLVING o UNCONFIRMED: no tocar nada.
  return { action: "NOOP" };
}

export async function getCallback(
  tableName: string,
  caseId: string,
): Promise<EvidenceCallbackRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { caseId, callbackType: CALLBACK_TYPE },
    }),
  );
  return result.Item as EvidenceCallbackRecord | undefined;
}

/**
 * COMMAND_ACK accepted:true confirma recepcion, pero NO termina la orden
 * (ver docs/EDGE_IMPLEMENTATION_GUIDE.md). Solo avanza PENDING->ACK_ACCEPTED.
 */
export async function markAckAccepted(
  tableName: string,
  caseId: string,
  commandId: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: CALLBACK_TYPE },
        UpdateExpression: "SET #status = :ackAccepted, updatedAt = :now",
        ConditionExpression: "commandId = :commandId AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":ackAccepted": "ACK_ACCEPTED",
          ":pending": "PENDING",
          ":commandId": commandId,
          ":now": new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false; // ACK duplicado (reentrega): no-op idempotente.
    }
    throw error;
  }
}

export interface LeaseHandle {
  leaseId: string;
  taskToken: string;
}

/**
 * Lease con propietario unico (resolutionLeaseId): el finalize/release
 * solo puede completarse si el leaseId sigue siendo el mismo, evitando que
 * un worker viejo cuyo lease vencio marque el resultado mientras otro
 * worker ya tomo un lease nuevo (carrera ABA).
 */
export async function acquireResolutionLease(
  tableName: string,
  caseId: string,
  commandId: string,
  leaseSeconds: number,
): Promise<LeaseHandle | undefined> {
  const leaseId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: CALLBACK_TYPE },
        UpdateExpression:
          "SET #status = :resolving, resolutionLeaseId = :leaseId, " +
          "resolutionLeaseExpiresAt = :leaseExpiry, updatedAt = :now",
        ConditionExpression:
          "commandId = :commandId AND (" +
          "#status = :pending OR #status = :ackAccepted OR #status = :unconfirmed OR " +
          "(#status = :resolvingState AND resolutionLeaseExpiresAt < :nowNum)" +
          ")",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolving": "RESOLVING",
          ":resolvingState": "RESOLVING",
          ":leaseId": leaseId,
          ":leaseExpiry": now + leaseSeconds,
          ":now": new Date().toISOString(),
          ":commandId": commandId,
          ":pending": "PENDING",
          ":ackAccepted": "ACK_ACCEPTED",
          ":unconfirmed": "UNCONFIRMED",
          ":nowNum": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const attributes = result.Attributes as EvidenceCallbackRecord;
    return { leaseId, taskToken: attributes.taskToken };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return undefined; // ya resuelto, o contendido por otro worker vigente
    }
    throw error;
  }
}

/**
 * SendTaskSuccess/Failure devolvio un error ambiguo (token invalido/ya
 * vencido/no existe): NO se asume exito. Se libera el lease a UNCONFIRMED,
 * condicionado a seguir siendo el dueno del lease.
 */
export async function releaseLeaseAsUnconfirmed(
  tableName: string,
  caseId: string,
  lease: LeaseHandle,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: CALLBACK_TYPE },
        UpdateExpression:
          "SET #status = :unconfirmed, updatedAt = :now " +
          "REMOVE resolutionLeaseId, resolutionLeaseExpiresAt",
        ConditionExpression: "#status = :resolving AND resolutionLeaseId = :leaseId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":unconfirmed": "UNCONFIRMED",
          ":resolving": "RESOLVING",
          ":leaseId": lease.leaseId,
          ":now": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // Un worker mas nuevo ya tomo un lease distinto (o ya reconcilio);
    // nos retiramos sin tocar nada.
  }
}

/**
 * Unica via legitima a RESOLVED por resolucion directa de callback:
 * SendTaskSuccess/Failure respondio correctamente. Condicionado al
 * leaseId propio (carrera ABA).
 */
export async function finalizeResolved(
  tableName: string,
  caseId: string,
  lease: LeaseHandle,
  outcomeType: ResolvedOutcomeType,
  reason?: string,
): Promise<void> {
  const reasonSet = reason !== undefined ? ", resolvedReason = :reason" : "";
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: CALLBACK_TYPE },
        UpdateExpression:
          `SET #status = :resolved, resolvedOutcomeType = :outcomeType${reasonSet}, updatedAt = :now ` +
          "REMOVE resolutionLeaseId, resolutionLeaseExpiresAt",
        ConditionExpression: "#status = :resolving AND resolutionLeaseId = :leaseId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolved": "RESOLVED",
          ":resolving": "RESOLVING",
          ":leaseId": lease.leaseId,
          ":outcomeType": outcomeType,
          ":now": new Date().toISOString(),
          ...(reason !== undefined ? { ":reason": reason } : {}),
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // Un worker mas nuevo ya tomo el lease, o RecordEvidenceOutcome ya
    // reconcilio primero: no sobrescribir.
  }
}

/**
 * Usada exclusivamente por recordEvidenceOutcomeFn: es la autoridad final
 * de todo el workflow (corre tanto si Step Functions llego aqui por exito
 * como por States.Timeout o por el catch-all de error). Reconciliar sin
 * condicionar por lease/status sana cualquier EvidenceCallbacks huerfano
 * en RESOLVING/UNCONFIRMED (p. ej. si SendTaskSuccess tuvo exito pero el
 * Lambda de callback murio antes de marcar RESOLVED).
 */
export async function reconcileAfterWorkflowOutcome(
  tableName: string,
  caseId: string,
  outcomeType: ResolvedOutcomeType,
  reason?: string,
): Promise<void> {
  const reasonSet = reason !== undefined ? ", resolvedReason = :reason" : "";
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: CALLBACK_TYPE },
        UpdateExpression:
          `SET #status = :resolved, resolvedOutcomeType = :outcomeType${reasonSet}, updatedAt = :now ` +
          "REMOVE resolutionLeaseId, resolutionLeaseExpiresAt",
        ConditionExpression: "attribute_exists(caseId)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolved": "RESOLVED",
          ":outcomeType": outcomeType,
          ":now": new Date().toISOString(),
          ...(reason !== undefined ? { ":reason": reason } : {}),
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // No existe registro (camino SKIPPED_NO_CONSENT, que nunca creo uno):
    // no hay nada que reconciliar.
  }
}
