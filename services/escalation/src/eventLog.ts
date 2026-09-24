import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";

export type EscalationEventType = "ESCALATED_BLOCKED" | "EMERGENCY_CALL_INITIATED" | "EMERGENCY_CALL_FAILED";

export interface EscalationEventLogEntry {
  caseId: string;
  eventType: EscalationEventType;
  reason?: string;
  contactId?: string;
}

/**
 * Auditoria segura: solo IDs, codigos cerrados y timestamps. Nunca el
 * numero de destino, credenciales de Connect, ni texto libre. Idempotente
 * por (caseId, occurredAt#eventId) -- mismo patron que
 * services/evidence/src/eventLog.ts.
 */
export async function writeEscalationEventLog(
  tableName: string,
  entry: EscalationEventLogEntry,
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const eventId = randomUUID();

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        caseId: entry.caseId,
        occurredAtEventId: `${occurredAt}#${eventId}`,
        eventType: entry.eventType,
        occurredAt,
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        ...(entry.contactId !== undefined ? { contactId: entry.contactId } : {}),
      },
    }),
  );
}
