import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { getCase, hasDeviceAccess } from "./caseAccess.js";
import { getUserId } from "./authContext.js";
import { applyAlertDecision, type AlertDecision } from "./alertDecision.js";
import { writeCaseActionEventLog, type CaseActionEventType } from "./eventLog.js";

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const EVENT_TYPES: Record<AlertDecision, { applied: CaseActionEventType; noop: CaseActionEventType; rejected: CaseActionEventType }> = {
  CANCELLED: {
    applied: "CANCEL_ALERT_APPLIED",
    noop: "CANCEL_ALERT_NOOP",
    rejected: "CANCEL_ALERT_REJECTED",
  },
  ESCALATED: {
    applied: "ESCALATE_APPLIED",
    noop: "ESCALATE_NOOP",
    rejected: "ESCALATE_REJECTED",
  },
};

function buildConflictMessage(result: { humanDecision: string; dialStatus?: string; conflictReason?: string }): string {
  switch (result.conflictReason) {
    case "CALL_ALREADY_IN_PROGRESS":
      return `La llamada de emergencia ya ${result.dialStatus === "CALLED" ? "se completó" : "inició"}; no se puede cancelar ni cambiar la decisión.`;
    case "OPPOSITE_DECISION_ALREADY_APPLIED":
      return `El caso ya tiene una decisión distinta registrada: ${result.humanDecision}`;
    default:
      return "El caso ya tiene un estado en conflicto con la acción solicitada.";
  }
}

/**
 * Nucleo compartido por cancelCaseHandler (CANCEL_ALERT) y
 * escalateCaseHandler (ESCALATE): mismo chequeo de autorizacion, misma
 * logica de decision idempotente/determinista (ver alertDecision.ts), y
 * misma auditoria incondicional en EventLog de CADA intento -- aplicado,
 * repetido (no-op) o rechazado por conflicto.
 *
 * `humanDecision` es un campo DISTINTO de `notificationStatus` (SNS) y de
 * `dialStatus` (llamada de EscalationPolicy/EmergencyDialer) -- ver
 * alertDecision.ts. Una vez que `dialStatus` es DIALING/CALLED, esta ruta
 * responde 409 con `conflictReason: CALL_ALREADY_IN_PROGRESS`: nunca finge
 * haber cancelado una llamada que ya inicio.
 */
export async function handleCaseDecision(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  decision: AlertDecision,
): Promise<APIGatewayProxyResultV2> {
  const caseId = event.pathParameters?.caseId;
  if (!caseId) {
    return jsonResponse(400, { error: "Falta caseId en la ruta" });
  }

  const userId = getUserId(event);
  if (!userId) {
    return jsonResponse(401, { error: "Token sin sub valido" });
  }

  const caseItem = await getCase(caseId);
  if (!caseItem) {
    return jsonResponse(404, { error: "Caso no encontrado" });
  }

  if (!(await hasDeviceAccess(userId, caseItem.deviceId))) {
    return jsonResponse(403, { error: "No tienes acceso a este caso" });
  }

  const result = await applyAlertDecision(caseItem, decision, userId);
  const eventTypes = EVENT_TYPES[decision];

  await writeCaseActionEventLog({
    caseId,
    userId,
    resultingHumanDecision: result.humanDecision,
    conflictReason: result.conflictReason,
    eventType:
      result.outcome === "APPLIED" ? eventTypes.applied : result.outcome === "NOOP" ? eventTypes.noop : eventTypes.rejected,
  });

  if (result.outcome === "CONFLICT") {
    return jsonResponse(409, {
      caseId,
      humanDecision: result.humanDecision,
      ...(result.dialStatus ? { dialStatus: result.dialStatus } : {}),
      conflictReason: result.conflictReason,
      error: buildConflictMessage(result),
    });
  }

  return jsonResponse(200, { caseId, humanDecision: result.humanDecision });
}
