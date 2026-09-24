import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";
import { casesConfig } from "./casesConfig.js";
import type { CaseRecord } from "./caseAccess.js";

export type AlertDecision = "CANCELLED" | "ESCALATED";
export type ApplyDecisionOutcome = "APPLIED" | "NOOP" | "CONFLICT";

export interface ApplyDecisionResult {
  outcome: ApplyDecisionOutcome;
  alertStatus: string;
}

const UNDECIDED_CONDITION = "attribute_not_exists(alertStatus) OR alertStatus IN (:pending, :sent, :failed)";
const UNDECIDED_VALUES = { ":pending": "PENDING", ":sent": "SENT", ":failed": "FAILED" };

/**
 * Aplica CANCEL_ALERT o ESCALATE de forma atomica y determinista sobre
 * AnomalyCases + Alerts a la vez (TransactWriteItems: ambas tablas
 * concuerdan siempre, nunca una decision a medias). La condicion comun
 * "todavia sin decision humana" (PENDING/SENT/FAILED, o Alerts inexistente
 * aun -- ver mas abajo) es el unico punto de dedup/concurrencia:
 *
 * - Repetir la MISMA decision que ya gano: la transaccion se cancela, pero
 *   al releer el estado coincide con lo pedido -> NOOP (200 idempotente,
 *   sin volver a escribir).
 * - La decision CONTRARIA ya gano la carrera: la transaccion se cancela y
 *   el estado leido difiere de lo pedido -> CONFLICT (409, nunca se miente
 *   sobre que paso).
 *
 * Alerts puede no existir todavia (p. ej. una anomalia visual cuya
 * evidencia/analisis, y por tanto su alerta, aun no ha corrido -- ver
 * dispatchAlertFn.ts). El UpdateItem de Alerts usa `if_not_exists()` para
 * autocompletar los campos descriptivos en ese caso: esto es
 * intencional, no un efecto secundario a evitar. Si un familiar cancela
 * ANTES de que exista una alerta, esa cancelacion debe impedir que
 * dispatchAlertFn envie una mas tarde -- su propio PutItem condicional
 * (`attribute_not_exists(caseId)`) fallara contra este registro
 * pre-existente y lo tratara como ya resuelto.
 */
export async function applyAlertDecision(
  caseRecord: CaseRecord,
  decision: AlertDecision,
  userId: string,
): Promise<ApplyDecisionResult> {
  const now = new Date().toISOString();
  const timestampField = decision === "CANCELLED" ? "cancelledAt" : "escalatedAt";
  const actorField = decision === "CANCELLED" ? "cancelledBy" : "escalatedBy";

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: casesConfig.anomalyCasesTableName,
              Key: { caseId: caseRecord.caseId },
              UpdateExpression: `SET alertStatus = :decision, ${timestampField} = :now, ${actorField} = :userId`,
              ConditionExpression: `attribute_exists(caseId) AND (${UNDECIDED_CONDITION})`,
              ExpressionAttributeValues: { ...UNDECIDED_VALUES, ":decision": decision, ":now": now, ":userId": userId },
            },
          },
          {
            Update: {
              TableName: casesConfig.alertsTableName,
              Key: { caseId: caseRecord.caseId },
              UpdateExpression:
                `SET alertStatus = :decision, ${timestampField} = :now, ${actorField} = :userId, updatedAt = :now, ` +
                "recipientId = if_not_exists(recipientId, :recipientId), " +
                "deviceId = if_not_exists(deviceId, :deviceId), " +
                "anomalyType = if_not_exists(anomalyType, :anomalyType), " +
                "eventType = if_not_exists(eventType, :eventType), " +
                "createdAt = if_not_exists(createdAt, :now), " +
                "notifiedCaregiverIds = if_not_exists(notifiedCaregiverIds, :emptyList)",
              ConditionExpression: UNDECIDED_CONDITION,
              ExpressionAttributeValues: {
                ...UNDECIDED_VALUES,
                ":decision": decision,
                ":now": now,
                ":userId": userId,
                ":recipientId": caseRecord.recipientId,
                ":deviceId": caseRecord.deviceId,
                ":anomalyType": caseRecord.anomalyType,
                ":eventType": caseRecord.eventType,
                ":emptyList": [],
              },
            },
          },
        ],
      }),
    );
    return { outcome: "APPLIED", alertStatus: decision };
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) {
      throw error;
    }
  }

  // AnomalyCases.alertStatus es la fuente autoritativa para desempatar NOOP
  // de CONFLICT (ver docstring de la funcion).
  const current = await ddb.send(
    new GetCommand({
      TableName: casesConfig.anomalyCasesTableName,
      Key: { caseId: caseRecord.caseId },
      ConsistentRead: true,
    }),
  );
  const currentAlertStatus = (current.Item?.alertStatus as string | undefined) ?? "UNKNOWN";
  return {
    outcome: currentAlertStatus === decision ? "NOOP" : "CONFLICT",
    alertStatus: currentAlertStatus,
  };
}
