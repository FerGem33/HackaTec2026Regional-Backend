import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { casesConfig } from "./casesConfig.js";
import { ddb } from "./clients.js";
import type { CaseRecord } from "./caseAccess.js";
import {
  getPendingHumanDecisionCallback,
  HUMAN_DECISION_CALLBACK_TYPE,
  resolveHumanDecisionCallback,
  type PendingHumanDecisionCallback,
} from "./humanDecisionCallback.js";

export type AlertDecision = "CANCELLED" | "ESCALATED";
export type ApplyDecisionOutcome = "APPLIED" | "NOOP" | "CONFLICT";
export type ConflictReason = "OPPOSITE_DECISION_ALREADY_APPLIED" | "CALL_ALREADY_IN_PROGRESS" | "UNKNOWN";

export interface ApplyDecisionResult {
  outcome: ApplyDecisionOutcome;
  humanDecision: string;
  dialStatus?: string;
  conflictReason?: ConflictReason;
}

/**
 * `humanDecision` (CANCELLED/ESCALATED), `notificationStatus`
 * (PENDING/PUBLISHED/FAILED, escrito solo por dispatchAlertFn.ts) y
 * `dialStatus` (DIALING/CALLED/BLOCKED, escrito solo por
 * escalationPolicyFn.ts) son TRES campos independientes en AnomalyCases y
 * Alerts -- nunca un solo campo compartido. Un `sns:Publish` exitoso
 * prueba que SNS acepto el mensaje, no que un familiar lo leyo; mezclarlos
 * fue el diseno original y se corrigio explicitamente antes de implementar
 * el hito de escalamiento.
 */
const HUMAN_DECISION_UNSET_CONDITION = "attribute_not_exists(humanDecision)";

/**
 * Carrera critica (corregida a pedido del coordinador): una vez que
 * EscalationPolicy reclama `dialStatus = DIALING` (o ya llego a `CALLED`),
 * NINGUNA decision humana nueva puede escribir `humanDecision` -- la
 * llamada ya inicio o termino. La API debe reportarlo como conflicto
 * auditado, nunca fingir que canceló una llamada en curso. Simetricamente,
 * escalationPolicyFn.ts nunca reclama DIALING si `humanDecision ===
 * "CANCELLED"` ya existe (ver ese modulo). Ambas transiciones usan
 * condiciones atomicas de DynamoDB sobre el MISMO item; ninguna de las dos
 * partes puede "ganar" después de que la otra ya escribio.
 */
const DIAL_NOT_IN_PROGRESS_CONDITION = "attribute_not_exists(dialStatus) OR (dialStatus <> :dialing AND dialStatus <> :called)";
const DIAL_IN_PROGRESS_VALUES = { ":dialing": "DIALING", ":called": "CALLED" };

interface CurrentCaseState {
  humanDecision?: string;
  dialStatus?: string;
}

/**
 * Aplica CANCEL_ALERT o ESCALATE de forma atomica y determinista sobre
 * AnomalyCases + Alerts (+ el callback de Step Functions si la maquina ya
 * esta esperando uno, ver humanDecisionCallback.ts) mediante
 * `TransactWriteItems`.
 *
 * - Repetir la MISMA decision que ya gano -> NOOP (200 idempotente).
 * - La decision CONTRARIA ya gano -> CONFLICT (409), conflictReason
 *   OPPOSITE_DECISION_ALREADY_APPLIED.
 * - `dialStatus` ya es DIALING/CALLED -> CONFLICT (409), conflictReason
 *   CALL_ALREADY_IN_PROGRESS: la llamada ya inicio o termino, nunca se
 *   finge una cancelacion que no ocurrio.
 *
 * Alerts puede no existir todavia (anomalia cuya evidencia/analisis, y por
 * tanto su alerta, aun no corrio). El UpdateItem de Alerts usa
 * `if_not_exists()` para autocompletar los campos descriptivos en ese
 * caso -- intencional: si un familiar decide ANTES de que exista una
 * alerta, esa decision debe impedir que dispatchAlertFn publique una mas
 * tarde (su propio PutItem condicional fallara contra este registro
 * pre-existente).
 */
export async function applyAlertDecision(
  caseRecord: CaseRecord,
  decision: AlertDecision,
  userId: string,
): Promise<ApplyDecisionResult> {
  const now = new Date().toISOString();
  const timestampField = decision === "CANCELLED" ? "cancelledAt" : "escalatedAt";
  const actorField = decision === "CANCELLED" ? "cancelledBy" : "escalatedBy";

  const pendingCallback = await getPendingHumanDecisionCallback(caseRecord.caseId);

  const applied = await tryApplyTransaction(caseRecord, decision, userId, now, timestampField, actorField, pendingCallback);

  if (applied === "SUCCEEDED") {
    if (pendingCallback) {
      await resolveHumanDecisionCallback(caseRecord.caseId, pendingCallback.taskToken, decision, userId);
    }
    return { outcome: "APPLIED", humanDecision: decision };
  }

  // La transaccion se cancelo. Releer el estado real para decidir entre
  // NOOP, CONFLICT y el unico caso corregible sin intervencion humana: el
  // taskToken cambio entre nuestra lectura y el commit (Step Functions
  // reintento requestHumanDecisionFn justo en ese instante) mientras la
  // decision sobre el caso en si seguia siendo valida.
  const current = await readCurrentCaseState(caseRecord.caseId);

  if (current.humanDecision === undefined && !isDialInProgress(current.dialStatus) && pendingCallback) {
    // Reintento acotado a UNA vez, sin el 3er item: la decision sobre el
    // caso se aplica de todos modos. El taskToken obsoleto queda sin
    // resolver por esta via -- inofensivo: escalationPolicyFn.ts vuelve a
    // verificar humanDecision de forma independiente, y el timeout nativo
    // del wait resuelve la maquina si nadie mas lo hace (ver docstring de
    // humanDecisionCallback.ts).
    const retried = await tryApplyTransaction(
      caseRecord,
      decision,
      userId,
      now,
      timestampField,
      actorField,
      undefined,
    );
    if (retried === "SUCCEEDED") {
      return { outcome: "APPLIED", humanDecision: decision };
    }
    const afterRetry = await readCurrentCaseState(caseRecord.caseId);
    return classifyConflict(decision, afterRetry);
  }

  return classifyConflict(decision, current);
}

function classifyConflict(decision: AlertDecision, current: CurrentCaseState): ApplyDecisionResult {
  if (current.humanDecision === decision) {
    return { outcome: "NOOP", humanDecision: decision };
  }
  if (isDialInProgress(current.dialStatus)) {
    return {
      outcome: "CONFLICT",
      humanDecision: current.humanDecision ?? "UNDECIDED",
      dialStatus: current.dialStatus,
      conflictReason: "CALL_ALREADY_IN_PROGRESS",
    };
  }
  if (current.humanDecision !== undefined) {
    return {
      outcome: "CONFLICT",
      humanDecision: current.humanDecision,
      conflictReason: "OPPOSITE_DECISION_ALREADY_APPLIED",
    };
  }
  return { outcome: "CONFLICT", humanDecision: "UNDECIDED", conflictReason: "UNKNOWN" };
}

function isDialInProgress(dialStatus: string | undefined): boolean {
  return dialStatus === "DIALING" || dialStatus === "CALLED";
}

async function readCurrentCaseState(caseId: string): Promise<CurrentCaseState> {
  const current = await ddb.send(
    new GetCommand({
      TableName: casesConfig.anomalyCasesTableName,
      Key: { caseId },
      ConsistentRead: true,
    }),
  );
  return {
    humanDecision: current.Item?.humanDecision as string | undefined,
    dialStatus: current.Item?.dialStatus as string | undefined,
  };
}

async function tryApplyTransaction(
  caseRecord: CaseRecord,
  decision: AlertDecision,
  userId: string,
  now: string,
  timestampField: string,
  actorField: string,
  pendingCallback: PendingHumanDecisionCallback | undefined,
): Promise<"SUCCEEDED" | "CANCELLED"> {
  const transactItems: TransactWriteCommandInput["TransactItems"] = [
    {
      Update: {
        TableName: casesConfig.anomalyCasesTableName,
        Key: { caseId: caseRecord.caseId },
        UpdateExpression: `SET humanDecision = :decision, ${timestampField} = :now, ${actorField} = :userId`,
        ConditionExpression: `attribute_exists(caseId) AND ${HUMAN_DECISION_UNSET_CONDITION} AND (${DIAL_NOT_IN_PROGRESS_CONDITION})`,
        ExpressionAttributeValues: {
          ...DIAL_IN_PROGRESS_VALUES,
          ":decision": decision,
          ":now": now,
          ":userId": userId,
        },
      },
    },
    {
      Update: {
        TableName: casesConfig.alertsTableName,
        Key: { caseId: caseRecord.caseId },
        UpdateExpression:
          `SET humanDecision = :decision, ${timestampField} = :now, ${actorField} = :userId, updatedAt = :now, ` +
          "recipientId = if_not_exists(recipientId, :recipientId), " +
          "deviceId = if_not_exists(deviceId, :deviceId), " +
          "anomalyType = if_not_exists(anomalyType, :anomalyType), " +
          "eventType = if_not_exists(eventType, :eventType), " +
          "createdAt = if_not_exists(createdAt, :now), " +
          "notifiedCaregiverIds = if_not_exists(notifiedCaregiverIds, :emptyList)",
        ConditionExpression: HUMAN_DECISION_UNSET_CONDITION,
        ExpressionAttributeValues: {
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
  ];

  if (pendingCallback) {
    transactItems.push({
      Update: {
        TableName: casesConfig.caseActionCallbacksTableName,
        Key: { caseId: caseRecord.caseId, callbackType: HUMAN_DECISION_CALLBACK_TYPE },
        UpdateExpression: "SET #status = :resolving, updatedAt = :now",
        ConditionExpression: "#status = :pending AND taskToken = :expectedToken",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolving": "RESOLVING",
          ":pending": "PENDING",
          ":expectedToken": pendingCallback.taskToken,
          ":now": now,
        },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    return "SUCCEEDED";
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      return "CANCELLED";
    }
    throw error;
  }
}
