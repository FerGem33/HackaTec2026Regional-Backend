import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { casesConfig } from "./casesConfig.js";

export type CaseActionEventType =
  | "CANCEL_ALERT_APPLIED"
  | "CANCEL_ALERT_NOOP"
  | "CANCEL_ALERT_REJECTED"
  | "ESCALATE_APPLIED"
  | "ESCALATE_NOOP"
  | "ESCALATE_REJECTED";

export interface CaseActionLogEntry {
  caseId: string;
  eventType: CaseActionEventType;
  userId: string;
  resultingHumanDecision: string;
  conflictReason?: string;
}

/**
 * Auditoria de CADA intento de accion humana (aplicado, no-op idempotente o
 * rechazado por conflicto), no solo de los que cambian estado -- a
 * diferencia de writeEvidenceEventLog (services/evidence/src/eventLog.ts),
 * esta escritura no es idempotente por eventId: cada llamada HTTP real,
 * incluida una repeticion intencional del usuario, es un evento de
 * auditoria legitimo por si mismo (quien intento que, y que paso). Nunca
 * contiene datos sensibles: solo IDs, el tipo de evento y el resultado.
 */
export async function writeCaseActionEventLog(entry: CaseActionLogEntry): Promise<void> {
  const occurredAt = new Date().toISOString();
  const eventId = randomUUID();

  await ddb.send(
    new PutCommand({
      TableName: casesConfig.eventLogTableName,
      Item: {
        caseId: entry.caseId,
        occurredAtEventId: `${occurredAt}#${eventId}`,
        eventType: entry.eventType,
        occurredAt,
        userId: entry.userId,
        resultingHumanDecision: entry.resultingHumanDecision,
        ...(entry.conflictReason !== undefined ? { conflictReason: entry.conflictReason } : {}),
      },
    }),
  );
}
