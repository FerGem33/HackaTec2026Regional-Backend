import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { config } from "./recordCallOutcomeConfig.js";
import { writeEscalationEventLog } from "./eventLog.js";
import type { EmergencyDialerOutput } from "./emergencyDialerFn.js";

export interface RecordCallOutcomeInput {
  caseId: string;
  dialResult: EmergencyDialerOutput;
}

/**
 * Task separada de emergencyDialerFn.ts a proposito: esta Lambda nunca
 * tiene permisos Connect/SSM/KMS, solo DynamoDB/EventLog. Transiciona
 * `dialStatus` de DIALING (reclamado por escalationPolicyFn.ts) a su
 * estado final -- CALLED o FAILED -- y audita el resultado. Nunca el
 * numero de destino, solo el `contactId` opaco de Connect.
 */
export async function handler(input: RecordCallOutcomeInput): Promise<void> {
  const { caseId, dialResult } = input;

  if (dialResult.outcome === "CALLED") {
    await ddb.send(
      new UpdateCommand({
        TableName: config.anomalyCasesTableName,
        Key: { caseId },
        UpdateExpression: "SET dialStatus = :called, calledAt = :now, connectContactId = :contactId",
        ExpressionAttributeValues: {
          ":called": "CALLED",
          ":now": new Date().toISOString(),
          ":contactId": dialResult.contactId,
        },
      }),
    );
    await writeEscalationEventLog(config.eventLogTableName, {
      caseId,
      eventType: "EMERGENCY_CALL_INITIATED",
      contactId: dialResult.contactId,
    });
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: config.anomalyCasesTableName,
      Key: { caseId },
      UpdateExpression: "SET dialStatus = :failed, dialFailedReason = :reason",
      ExpressionAttributeValues: { ":failed": "FAILED", ":reason": dialResult.errorCode },
    }),
  );
  await writeEscalationEventLog(config.eventLogTableName, {
    caseId,
    eventType: "EMERGENCY_CALL_FAILED",
    reason: dialResult.errorCode,
  });
}
