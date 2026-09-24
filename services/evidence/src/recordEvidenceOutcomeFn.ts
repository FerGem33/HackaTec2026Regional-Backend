import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { requireEnv } from "./env.js";
import { reconcileAfterWorkflowOutcome, type ResolvedOutcomeType } from "./callbackStore.js";
import { writeEvidenceEventLog, type EvidenceEventType } from "./eventLog.js";
import type { CaseTaskInput } from "./types.js";

const config = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  evidenceCallbacksTableName: requireEnv("EVIDENCE_CALLBACKS_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
};

export type EvidenceStatus = "SKIPPED_NO_CONSENT" | "AVAILABLE" | "INCOMPLETE" | "ERROR";

export interface RecordEvidenceOutcomeInput extends CaseTaskInput {
  evidenceStatus: EvidenceStatus;
  evidenceReason?: string;
  evidenceS3Key?: string;
  evidenceImageId?: string;
}

function mapToResolvedOutcome(
  evidenceStatus: EvidenceStatus,
  evidenceReason?: string,
): ResolvedOutcomeType | undefined {
  if (evidenceStatus === "SKIPPED_NO_CONSENT") {
    return undefined; // nunca existio EvidenceCallbacks para este caso
  }
  if (evidenceStatus === "AVAILABLE") {
    return "UPLOADED";
  }
  switch (evidenceReason) {
    case "CommandRejected":
      return "REJECTED";
    case "EvidenceUploadFailed":
      return "UPLOAD_FAILED";
    case "EvidenceObjectMissing":
      return "OBJECT_MISSING";
    case "EvidenceObjectInvalid":
      return "OBJECT_INVALID";
    default:
      return "TIMEOUT";
  }
}

function mapToEventType(evidenceStatus: EvidenceStatus): EvidenceEventType {
  if (evidenceStatus === "AVAILABLE") return "EVIDENCE_AVAILABLE";
  if (evidenceStatus === "ERROR") return "EVIDENCE_ERROR";
  return "EVIDENCE_INCOMPLETE"; // cubre INCOMPLETE y SKIPPED_NO_CONSENT
}

/**
 * Unico lugar que actualiza AnomalyCases.evidenceStatus. Es tambien la
 * autoridad final que reconcilia EvidenceCallbacks (ver callbackStore.ts):
 * corre tanto si Step Functions llego aqui por exito, por States.Timeout o
 * por el catch-all de error tecnico, asi que sana cualquier registro
 * huerfano en RESOLVING/UNCONFIRMED sin importar la causa.
 */
export async function handler(input: RecordEvidenceOutcomeInput): Promise<CaseTaskInput> {
  const now = new Date().toISOString();
  const { caseDetail, evidenceStatus, evidenceReason, evidenceS3Key, evidenceImageId } = input;

  const setClauses = ["evidenceStatus = :status", "updatedAt = :now"];
  const values: Record<string, unknown> = { ":status": evidenceStatus, ":now": now };
  if (evidenceReason !== undefined) {
    setClauses.push("evidenceReason = :reason");
    values[":reason"] = evidenceReason;
  }
  if (evidenceS3Key !== undefined) {
    setClauses.push("evidenceS3Key = :s3Key");
    values[":s3Key"] = evidenceS3Key;
  }
  if (evidenceImageId !== undefined) {
    setClauses.push("evidenceImageId = :imageId");
    values[":imageId"] = evidenceImageId;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: config.anomalyCasesTableName,
      Key: { caseId: caseDetail.caseId },
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeValues: values,
    }),
  );

  await writeEvidenceEventLog(config.eventLogTableName, {
    caseId: caseDetail.caseId,
    eventType: mapToEventType(evidenceStatus),
    reason: evidenceReason,
    s3Key: evidenceS3Key,
    imageId: evidenceImageId,
  });

  const resolvedOutcome = mapToResolvedOutcome(evidenceStatus, evidenceReason);
  if (resolvedOutcome) {
    await reconcileAfterWorkflowOutcome(
      config.evidenceCallbacksTableName,
      caseDetail.caseId,
      resolvedOutcome,
      evidenceReason,
    );
  }

  return { caseDetail, executionArn: input.executionArn };
}
