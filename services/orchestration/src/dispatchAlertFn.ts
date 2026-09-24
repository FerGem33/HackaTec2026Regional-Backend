import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PublishCommand } from "@aws-sdk/client-sns";
import { ddb, sns } from "./clients.js";
import { config } from "./alertConfig.js";
import type { CaseTaskInput } from "./types.js";

/**
 * Task de Step Functions invocada en DOS puntos de la maquina de estados
 * (ver case-orchestration.ts): inmediatamente tras abrir el caso si es un
 * sensor critico (sin esperar evidencia ni Bedrock), y de nuevo al final
 * del tramo de evidencia/analisis como red de seguridad
 * ("NotifyCaregiversIfNotAlready"). Ambas invocaciones llaman a esta MISMA
 * funcion; la idempotencia vive aqui, no en la maquina de estados.
 *
 * `notificationStatus` (PENDING/PUBLISHED/FAILED) es deliberadamente un
 * campo DISTINTO de `humanDecision` (CANCELLED/ESCALATED, escrito solo por
 * services/cases/src/alertDecision.ts) y de `dialStatus` (DIALING/CALLED/
 * BLOCKED, escrito solo por escalationPolicyFn.ts): un `sns:Publish`
 * exitoso prueba que SNS aceptó el mensaje, NUNCA que un familiar lo leyó
 * ni que existe un canal humano activo. Fusionar estos tres estados en un
 * solo campo fue el diseño original y se corrigió explícitamente a pedido
 * del coordinador antes de implementar el hito de escalamiento.
 *
 * Dedup real (no solo "intentar evitar duplicados"): un `PutItem`
 * condicional `attribute_not_exists(caseId)` en Alerts es la unica reserva
 * atomica. Solo la invocacion que gana esa condicion llama a
 * `sns:Publish`; cualquier otra (el segundo punto de invocacion en el
 * camino feliz, o un reintento de Lambda) pierde la condicion y no publica
 * nada. Limite conocido: si la invocacion ganadora muere entre el PutItem y
 * el Publish, el registro queda `PENDING` -- la segunda invocacion lo
 * detecta (mismo caseId, `notificationStatus` todavia `PENDING` y con mas
 * de `STALE_PENDING_MS` desde `createdAt`) y retoma el envio desde ahi,
 * para no depender de una tercera invocacion que quiza nunca llegue.
 *
 * Un fallo de `sns:Publish` se audita como `FAILED` y NUNCA se relanza como
 * excepcion: no debe fallar la ejecucion de Step Functions ni bloquear el
 * resto del tramo de evidencia (ver requisitos del hito de alertas).
 */

const STALE_PENDING_MS = 2 * 60 * 1000;

interface AlertItem {
  caseId: string;
  recipientId: string;
  deviceId: string;
  anomalyType: string;
  eventType: string;
  severity?: string;
  notificationStatus: "PENDING" | "PUBLISHED" | "FAILED";
  notifiedCaregiverIds: string[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  snsMessageId?: string;
}

export async function handler(input: CaseTaskInput): Promise<CaseTaskInput> {
  const { caseDetail } = input;

  const notifiedCaregiverIds = await listCaregiverUserIds(caseDetail.deviceId);
  const claimed = await tryClaim(caseDetail, notifiedCaregiverIds);
  if (claimed) {
    await publishAndFinalize(caseDetail);
  }

  return input;
}

async function listCaregiverUserIds(deviceId: string): Promise<string[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: config.caregiverAccessTableName,
      IndexName: "CaregiverAccessByDevice",
      KeyConditionExpression: "deviceId = :deviceId",
      ExpressionAttributeValues: { ":deviceId": deviceId },
    }),
  );
  return (result.Items ?? []).map((item) => item.userId as string);
}

async function tryClaim(
  caseDetail: CaseTaskInput["caseDetail"],
  notifiedCaregiverIds: string[],
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  try {
    await ddb.send(
      new PutCommand({
        TableName: config.alertsTableName,
        Item: {
          caseId: caseDetail.caseId,
          recipientId: caseDetail.recipientId,
          deviceId: caseDetail.deviceId,
          anomalyType: caseDetail.anomalyType,
          eventType: caseDetail.eventType,
          ...(caseDetail.severity ? { severity: caseDetail.severity } : {}),
          notificationStatus: "PENDING",
          notifiedCaregiverIds,
          createdAt: nowIso,
          updatedAt: nowIso,
        } satisfies AlertItem,
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
    return true;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
  }

  // Ya existe un registro para este caso: solo re-reclamar si sigue
  // PENDING y es lo bastante viejo como para sospechar que la invocacion
  // original nunca llego a publicar (ver docstring del modulo).
  const existing = await ddb.send(
    new GetCommand({
      TableName: config.alertsTableName,
      Key: { caseId: caseDetail.caseId },
      ConsistentRead: true,
    }),
  );
  const existingItem = existing.Item as AlertItem | undefined;
  if (!existingItem || existingItem.notificationStatus !== "PENDING") {
    return false; // ya PUBLISHED o FAILED: no reenviar, es el camino feliz normal
  }
  if (Date.now() - Date.parse(existingItem.createdAt) < STALE_PENDING_MS) {
    return false; // probablemente en curso ahora mismo por la otra invocacion
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.alertsTableName,
        Key: { caseId: caseDetail.caseId },
        UpdateExpression: "SET updatedAt = :now",
        ConditionExpression: "notificationStatus = :pending AND createdAt = :createdAt",
        ExpressionAttributeValues: {
          ":now": nowIso,
          ":pending": "PENDING",
          ":createdAt": existingItem.createdAt,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false; // otra invocacion la retomo primero
    }
    throw error;
  }
}

async function publishAndFinalize(caseDetail: CaseTaskInput["caseDetail"]): Promise<void> {
  try {
    // Solo campos seguros: nunca summary de Bedrock, s3Key/URLs, imagenes
    // ni recipientId (quien recibe el correo ya sabe a quien cuida).
    const message = {
      caseId: caseDetail.caseId,
      eventType: caseDetail.eventType,
      anomalyType: caseDetail.anomalyType,
      ...(caseDetail.severity ? { severity: caseDetail.severity } : {}),
      occurredAt: caseDetail.occurredAt,
      instruction:
        "Revisa el caso y confirma o cancela la alerta desde la app/CLI de SenseCare.",
    };

    const result = await sns.send(
      new PublishCommand({
        TopicArn: config.alertsTopicArn,
        Subject: `SenseCare: alerta de caso ${caseDetail.caseId}`,
        Message: JSON.stringify(message),
      }),
    );

    const publishedAt = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: config.alertsTableName,
        Key: { caseId: caseDetail.caseId },
        UpdateExpression:
          "SET notificationStatus = :published, publishedAt = :publishedAt, snsMessageId = :messageId, updatedAt = :publishedAt",
        ExpressionAttributeValues: {
          ":published": "PUBLISHED",
          ":publishedAt": publishedAt,
          ":messageId": result.MessageId ?? "unknown",
        },
      }),
    );
    await mirrorNotificationStatusOntoCase(caseDetail.caseId, "PUBLISHED");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "dispatch_alert_publish_failed",
        caseId: caseDetail.caseId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    await ddb.send(
      new UpdateCommand({
        TableName: config.alertsTableName,
        Key: { caseId: caseDetail.caseId },
        UpdateExpression: "SET notificationStatus = :failed, updatedAt = :now",
        ExpressionAttributeValues: { ":failed": "FAILED", ":now": new Date().toISOString() },
      }),
    );
    await mirrorNotificationStatusOntoCase(caseDetail.caseId, "FAILED");
    // Nunca relanzar: un fallo de SNS no debe fallar el caso ni bloquear el
    // resto de la ejecucion (evidencia/analisis siguen su curso normal).
  }
}

async function mirrorNotificationStatusOntoCase(
  caseId: string,
  notificationStatus: "PUBLISHED" | "FAILED",
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: config.anomalyCasesTableName,
      Key: { caseId },
      UpdateExpression: "SET notificationStatus = :notificationStatus",
      ExpressionAttributeValues: { ":notificationStatus": notificationStatus },
    }),
  );
}
