import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";

export type EvidenceEventType =
  | "EVIDENCE_REQUESTED"
  | "EVIDENCE_ACKNOWLEDGED"
  | "EVIDENCE_REJECTED"
  | "EVIDENCE_AVAILABLE"
  | "EVIDENCE_INCOMPLETE"
  | "EVIDENCE_ERROR";

export interface EvidenceEventLogEntry {
  caseId: string;
  eventType: EvidenceEventType;
  deviceId?: string;
  recipientId?: string;
  commandId?: string;
  s3Key?: string;
  imageId?: string;
  reason?: string;
}

/**
 * Auditoria segura en EventLog: solo IDs, codigos cerrados y timestamps.
 * Nunca uploadUrl, taskToken, bytes ni contenido de imagen. Idempotente por
 * (caseId, occurredAt#eventId) igual que anomalyIngestCore.ts en Hito 2.
 */
export async function writeEvidenceEventLog(
  tableName: string,
  entry: EvidenceEventLogEntry,
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const eventId = randomUUID();

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          caseId: entry.caseId,
          occurredAtEventId: `${occurredAt}#${eventId}`,
          eventType: entry.eventType,
          occurredAt,
          ...(entry.deviceId !== undefined ? { deviceId: entry.deviceId } : {}),
          ...(entry.recipientId !== undefined ? { recipientId: entry.recipientId } : {}),
          ...(entry.commandId !== undefined ? { commandId: entry.commandId } : {}),
          ...(entry.s3Key !== undefined ? { s3Key: entry.s3Key } : {}),
          ...(entry.imageId !== undefined ? { imageId: entry.imageId } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        },
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // Redelivery: entrada de auditoria ya escrita, no-op idempotente.
  }
}
