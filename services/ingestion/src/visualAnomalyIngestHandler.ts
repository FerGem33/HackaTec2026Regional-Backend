import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { validateVisualAnomaly } from "@sensecare/contracts";
import { processAnomalyRecord } from "./anomalyIngestCore.js";

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      await processAnomalyRecord(record.body, validateVisualAnomaly);
    } catch (error) {
      console.error("visualAnomalyIngestHandler: fallo procesando registro", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : error,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
