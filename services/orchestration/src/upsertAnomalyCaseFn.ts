import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";
import { config } from "./taskConfig.js";
import type { CaseTaskInput } from "./types.js";

interface AnomalyCaseItem {
  caseId: string;
  status: "DETECTED";
  executionArn: string;
  deviceId: string;
  recipientId: string;
  anomalyType: string;
  eventType: string;
  firstEventId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Task de Step Functions: crea AnomalyCases si no existe, o lo refresca de
 * forma idempotente si ya existe (ejecucion repetida sobre el mismo
 * caseId). El update de colision SOLO toca updatedAt: nunca pisa status,
 * createdAt ni executionArn, para conservar la procedencia de la
 * ejecucion original que creo el caso.
 */
export async function handler(input: CaseTaskInput): Promise<CaseTaskInput> {
  const { caseDetail, executionArn } = input;
  const now = new Date().toISOString();

  try {
    await ddb.send(
      new PutCommand({
        TableName: config.anomalyCasesTableName,
        Item: {
          caseId: caseDetail.caseId,
          status: "DETECTED",
          executionArn,
          deviceId: caseDetail.deviceId,
          recipientId: caseDetail.recipientId,
          anomalyType: caseDetail.anomalyType,
          eventType: caseDetail.eventType,
          firstEventId: caseDetail.eventId,
          createdAt: now,
          updatedAt: now,
        } satisfies AnomalyCaseItem,
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // El caso ya existe (ejecucion repetida sobre el mismo caseId). Solo
    // refrescamos updatedAt; status/createdAt/executionArn originales se
    // conservan intactos (executionArn de la ejecucion que abrio el caso
    // primero, no de esta).
    await ddb.send(
      new UpdateCommand({
        TableName: config.anomalyCasesTableName,
        Key: { caseId: caseDetail.caseId },
        UpdateExpression: "SET updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":updatedAt": now },
      }),
    );
  }

  return input;
}
