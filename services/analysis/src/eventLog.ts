import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";

export type AnalysisEventType = "ANALYSIS_REQUESTED" | "ANALYSIS_COMPLETED" | "ANALYSIS_UNCERTAIN";

export interface AnalysisEventLogEntry {
  caseId: string;
  eventType: AnalysisEventType;
  imageId?: string;
  s3Key?: string;
  riskIndicators?: string[];
  needsHumanReview?: boolean;
  failureReason?: string;
}

/**
 * Auditoria segura en EventLog: solo IDs, enums cerrados y booleanos.
 * NUNCA `summary` (texto libre generado por el modelo), bytes de imagen ni
 * la respuesta cruda de Bedrock. Idempotente por (caseId, occurredAt#eventId)
 * igual que services/evidence/src/eventLog.ts; cada llamada es una entrada
 * de auditoria nueva (un reintento de AnalyzeEvidence escribe un segundo
 * ANALYSIS_REQUESTED, reflejando el intento real -- mismo principio ya
 * establecido para EVIDENCE_REQUESTED).
 */
export async function writeAnalysisEventLog(
  tableName: string,
  entry: AnalysisEventLogEntry,
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
          ...(entry.imageId !== undefined ? { imageId: entry.imageId } : {}),
          ...(entry.s3Key !== undefined ? { s3Key: entry.s3Key } : {}),
          ...(entry.riskIndicators !== undefined ? { riskIndicators: entry.riskIndicators } : {}),
          ...(entry.needsHumanReview !== undefined ? { needsHumanReview: entry.needsHumanReview } : {}),
          ...(entry.failureReason !== undefined ? { failureReason: entry.failureReason } : {}),
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
