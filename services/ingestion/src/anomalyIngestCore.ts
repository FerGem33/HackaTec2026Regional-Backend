import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { AnomalyDetectedEventDetail, SensorAnomaly, VisualAnomaly } from "@sensecare/contracts";
import { ddb, eventBridge } from "./clients.js";
import { config } from "./config.js";
import { resolveRecipientId } from "./devices.js";
import { extractVerifiedPayload } from "./envelope.js";

type AnomalyPayload = VisualAnomaly | SensorAnomaly;

export interface AnomalyValidator<T extends AnomalyPayload> {
  (payload: unknown): payload is T;
  errors?: unknown;
}

interface OpenCaseLockItem {
  lockKey: string;
  caseId: string;
  deviceId: string;
  openedAt: string;
  firstEventId: string;
  expiresAt: number;
  publishLeaseExpiresAt?: number;
  eventBridgePublishedAt?: string;
}

/**
 * Nucleo compartido por visualAnomalyIngestHandler y
 * sensorAnomalyIngestHandler. Cada Lambda conoce su propio schema (cada
 * una escucha su propia cola SQS) y pasa el validador correspondiente.
 *
 * Estrategia de entrega: "al menos una vez", no "exactamente una vez".
 * EventLog es idempotente por eventId; la publicacion a EventBridge puede
 * duplicarse entre reintentos, y el Hito 4 debe absorberlo usando caseId
 * como nombre determinista de ejecucion de Step Functions (StartExecution
 * con el mismo nombre + mismo input es idempotente; con input distinto
 * lanza ExecutionAlreadyExists, tampoco crea una ejecucion duplicada).
 */
export async function processAnomalyRecord<T extends AnomalyPayload>(
  rawBody: string,
  validate: AnomalyValidator<T>,
): Promise<void> {
  // Separa y verifica mqttDeviceId (topic(4) de la IoT Rule) contra
  // payload.deviceId ANTES de validar el schema; ver envelope.ts.
  const payload: unknown = extractVerifiedPayload(rawBody);
  if (!validate(payload)) {
    throw new Error(`Anomalia invalida: ${JSON.stringify(validate.errors)}`);
  }
  const anomaly = payload;

  const recipientId = await resolveRecipientId(anomaly.deviceId);
  const lockKey = `${recipientId}#${anomaly.anomalyType}`;

  const caseId = await acquireOrReadLock(lockKey, anomaly);

  await writeEventLog(caseId, anomaly, recipientId);

  await tryPublishWithLease(lockKey, caseId, anomaly, recipientId);
}

async function acquireOrReadLock(lockKey: string, anomaly: AnomalyPayload): Promise<string> {
  const caseId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + config.openCaseLockTtlSeconds;

  try {
    await ddb.send(
      new PutCommand({
        TableName: config.openCaseLocksTableName,
        Item: {
          lockKey,
          caseId,
          deviceId: anomaly.deviceId,
          openedAt: anomaly.occurredAt,
          firstEventId: anomaly.eventId,
          expiresAt,
        } satisfies OpenCaseLockItem,
        // DynamoDB TTL no borra al instante en que expira (el barrido en
        // segundo plano puede tardar bastante); esta condicion permite
        // reabrir atomicamente un lock cuyo TTL ya vencio aunque el item
        // aun exista fisicamente en la tabla.
        ConditionExpression: "attribute_not_exists(lockKey) OR expiresAt <= :now",
        ExpressionAttributeValues: { ":now": now },
      }),
    );
    return caseId;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
  }

  const existing = await ddb.send(
    new GetCommand({
      TableName: config.openCaseLocksTableName,
      Key: { lockKey },
      // Lectura fuertemente consistente: acabamos de perder una condicion
      // de escritura contra este mismo item, no podemos arriesgarnos a
      // leer una copia replicada desactualizada.
      ConsistentRead: true,
    }),
  );
  const existingItem = existing.Item as OpenCaseLockItem | undefined;
  if (!existingItem?.caseId) {
    // Carrera muy improbable: perdimos la condicion pero una lectura
    // eventualmente consistente todavia no ve el item. Se propaga como
    // error transitorio para que SQS reintente.
    throw new Error(`No se pudo resolver caseId para lockKey=${lockKey}`);
  }
  return existingItem.caseId;
}

async function writeEventLog(
  caseId: string,
  anomaly: AnomalyPayload,
  recipientId: string,
): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: config.eventLogTableName,
        Item: {
          caseId,
          occurredAtEventId: `${anomaly.occurredAt}#${anomaly.eventId}`,
          eventType: anomaly.eventType,
          anomalyType: anomaly.anomalyType,
          deviceId: anomaly.deviceId,
          recipientId,
        },
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // Mismo eventId ya registrado (redelivery de SQS): no-op idempotente.
    // OJO: esto NO implica que ya se haya publicado a EventBridge, por eso
    // el intento de publicacion sigue su curso independientemente.
  }
}

async function tryPublishWithLease(
  lockKey: string,
  caseId: string,
  anomaly: AnomalyPayload,
  recipientId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiresAt = now + config.publishLeaseSeconds;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.openCaseLocksTableName,
        Key: { lockKey },
        UpdateExpression: "SET publishLeaseExpiresAt = :leaseExpiresAt",
        // attribute_not_exists(eventBridgePublishedAt) es la condicion
        // definitiva: una vez publicado con exito para este caso, ninguna
        // anomalia posterior debe volver a publicar, sin importar el
        // estado del lease. El resto de la condicion (lease vencido/libre)
        // solo evita publicaciones paralelas mientras aun no se ha
        // publicado.
        ConditionExpression:
          "attribute_not_exists(eventBridgePublishedAt) AND (attribute_not_exists(publishLeaseExpiresAt) OR publishLeaseExpiresAt < :now)",
        ExpressionAttributeValues: { ":leaseExpiresAt": leaseExpiresAt, ":now": now },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      // O ya se publico para este caso (eventBridgePublishedAt existe) o
      // otra invocacion concurrente tiene el lease vigente; en ambos casos,
      // con entrega "al menos una vez", esta invocacion no necesita
      // publicar.
      return;
    }
    throw error;
  }

  const response = await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: config.eventBusName,
          Source: "SenseCare",
          DetailType: "anomaly.detected",
          Detail: JSON.stringify({
            caseId,
            deviceId: anomaly.deviceId,
            recipientId,
            eventId: anomaly.eventId,
            eventType: anomaly.eventType,
            anomalyType: anomaly.anomalyType,
            occurredAt: anomaly.occurredAt,
          } satisfies AnomalyDetectedEventDetail),
        },
      ],
    }),
  );

  if (response.FailedEntryCount && response.FailedEntryCount > 0) {
    const [entry] = response.Entries ?? [];
    throw new Error(
      `PutEvents fallo para caseId=${caseId}: ${entry?.ErrorCode ?? "desconocido"} ${
        entry?.ErrorMessage ?? ""
      }`,
    );
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.openCaseLocksTableName,
        Key: { lockKey },
        UpdateExpression: "SET eventBridgePublishedAt = :publishedAt",
        ExpressionAttributeValues: { ":publishedAt": new Date().toISOString() },
      }),
    );
  } catch (error) {
    // Marca de auditoria best-effort: el evento ya se publico, no fallar
    // el registro por esto.
    console.warn("No se pudo registrar eventBridgePublishedAt", {
      caseId,
      error: error instanceof Error ? error.message : error,
    });
  }
}
