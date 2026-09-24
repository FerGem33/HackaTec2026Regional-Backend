import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SendMessagesCommand } from "@aws-sdk/client-pinpoint";
import { ddb, pinpoint } from "./clients.js";
import { pushConfig } from "./pushConfig.js";
import type { CaseTaskInput } from "./types.js";

/**
 * Task de Step Functions invocada en los MISMOS dos puntos de la maquina
 * de estados que dispatchAlertFn (ver case-orchestration.ts): inmediato
 * para sensor critico, y como red de seguridad al final del tramo de
 * evidencia/analisis. Complementa (no reemplaza) el aviso por email de
 * dispatchAlertFn -- es un canal adicional, dirigido por endpoint de
 * Pinpoint en vez de un topic SNS compartido.
 *
 * Dedup por caseId via una fila CLAIM en AlertDeliveries (PutItem
 * condicional `attribute_not_exists(caseId)`, mismo mecanismo de
 * dispatchAlertFn en Alerts). A diferencia de dispatchAlertFn, este claim
 * NO se reintenta si queda "stale": el push es un canal secundario/de
 * mejor esfuerzo (el email de dispatchAlertFn sigue siendo el canal
 * garantizado); si la invocacion ganadora muere entre el claim y el envio,
 * el caso simplemente no recibe push para ese evento, sin bloquear nada
 * mas. Simplificacion deliberada para mantener este primer tramo simple y
 * correcto; ver docs/IMPLEMENTATION_ROADMAP.md si se necesita reforzarlo.
 *
 * Un fallo de Pinpoint (llamada completa, o un endpoint individual) se
 * audita como FAILED y NUNCA se relanza como excepcion: no debe fallar la
 * ejecucion de Step Functions ni bloquear el resto del tramo de
 * evidencia/analisis (mismo requisito que dispatchAlertFn).
 */

const CLAIM_DELIVERY_ID = "CLAIM";

interface PushEndpointItem {
  userId: string;
  endpointId: string;
  status: "ACTIVE" | "DISABLED";
}

export async function handler(input: CaseTaskInput): Promise<CaseTaskInput> {
  const { caseDetail } = input;

  const claimed = await tryClaim(caseDetail.caseId);
  if (claimed) {
    await dispatchToAllEndpoints(caseDetail);
  }

  return input;
}

async function tryClaim(caseId: string): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: pushConfig.alertDeliveriesTableName,
        Item: { caseId, deliveryId: CLAIM_DELIVERY_ID, claimedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
    return true;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    return false; // ya reclamado por la otra invocacion (camino feliz normal, o en curso)
  }
}

async function dispatchToAllEndpoints(caseDetail: CaseTaskInput["caseDetail"]): Promise<void> {
  const userIds = await listCaregiverUserIds(caseDetail.deviceId);
  const endpointLists = await Promise.all(userIds.map(listActiveEndpoints));
  const endpoints = endpointLists.flat();

  if (endpoints.length === 0) {
    return; // sin endpoints activos: el email de dispatchAlertFn sigue siendo el canal garantizado
  }

  // Payload minimo, data-only: nunca recipientId, diagnostico de Bedrock,
  // imagen ni URL de S3. RawContent se entrega tal cual a FCM (mismo
  // formato plano `{ data: {...} }` que Alert.fromPushData ya espera en la
  // app movil), sin envolverlo en data.pinpoint.jsonBody.
  const rawContent = JSON.stringify({
    data: {
      type: "SENSECARE_ALERT",
      caseId: caseDetail.caseId,
      ...(caseDetail.severity ? { severity: caseDetail.severity } : {}),
      title: "Alerta SenseCare",
      body: "Revisa una alerta pendiente en la app.",
    },
  });

  let endpointResults: Record<string, { DeliveryStatus?: string; StatusMessage?: string }> = {};
  try {
    const result = await pinpoint.send(
      new SendMessagesCommand({
        ApplicationId: pushConfig.pinpointApplicationId,
        MessageRequest: {
          Endpoints: Object.fromEntries(endpoints.map((e) => [e.endpointId, {}])),
          MessageConfiguration: { GCMMessage: { RawContent: rawContent } },
        },
      }),
    );
    endpointResults = result.MessageResponse?.EndpointResult ?? {};
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "dispatch_push_send_messages_failed",
        caseId: caseDetail.caseId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await Promise.all(endpoints.map((e) => recordDelivery(caseDetail.caseId, e, "FAILED")));
    return;
  }

  await Promise.all(
    endpoints.map(async (endpoint) => {
      const deliveryStatus = endpointResults[endpoint.endpointId]?.DeliveryStatus;
      const status = deliveryStatus === "SUCCESSFUL" ? "PUBLISHED" : "FAILED";
      await recordDelivery(caseDetail.caseId, endpoint, status, endpointResults[endpoint.endpointId]?.StatusMessage);
      if (deliveryStatus === "PERMANENT_FAILURE") {
        await disableEndpoint(endpoint.userId, endpoint.endpointId);
      }
    }),
  );
}

async function listCaregiverUserIds(deviceId: string): Promise<string[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: pushConfig.caregiverAccessTableName,
      IndexName: "CaregiverAccessByDevice",
      KeyConditionExpression: "deviceId = :deviceId",
      ExpressionAttributeValues: { ":deviceId": deviceId },
    }),
  );
  return (result.Items ?? []).map((item) => item.userId as string);
}

async function listActiveEndpoints(userId: string): Promise<PushEndpointItem[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: pushConfig.caregiverPushEndpointsTableName,
      KeyConditionExpression: "userId = :userId",
      FilterExpression: "#status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":userId": userId, ":active": "ACTIVE" },
    }),
  );
  return (result.Items ?? []) as PushEndpointItem[];
}

async function recordDelivery(
  caseId: string,
  endpoint: PushEndpointItem,
  status: "PUBLISHED" | "FAILED",
  lastErrorCode?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: pushConfig.alertDeliveriesTableName,
      Item: {
        caseId,
        deliveryId: `PUSH#${endpoint.userId}#${endpoint.endpointId}`,
        status,
        ...(lastErrorCode ? { lastErrorCode } : {}),
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function disableEndpoint(userId: string, endpointId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: pushConfig.caregiverPushEndpointsTableName,
      Key: { userId, endpointId },
      UpdateExpression: "SET #status = :disabled, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":disabled": "DISABLED", ":now": new Date().toISOString() },
    }),
  );
}
