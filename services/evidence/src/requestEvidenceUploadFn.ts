import type { AnomalyDetectedEventDetail } from "@sensecare/contracts";
import { requireEnv, requirePositiveInt } from "./env.js";
import { prepareUploadCommand } from "./callbackStore.js";
import { presignEvidenceUpload } from "./presign.js";
import { publishUploadEvidenceCommand } from "./mqttPublish.js";
import { writeEvidenceEventLog } from "./eventLog.js";
import { resolveTaskToken } from "./tokenResolution.js";
import type { CaseTaskInput } from "./types.js";

const config = {
  evidenceCallbacksTableName: requireEnv("EVIDENCE_CALLBACKS_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  evidenceBucketName: requireEnv("EVIDENCE_BUCKET_NAME"),
  evidenceTimeoutSeconds: requirePositiveInt("EVIDENCE_UPLOAD_TIMEOUT_SECONDS", 60),
  ttlBufferSeconds: requirePositiveInt("EVIDENCE_CALLBACK_TTL_BUFFER_SECONDS", 3600),
};

/**
 * VISUAL_ANOMALY -> BUFFERED (la Pi ya tiene el frame del evento en su ring
 * buffer). SENSOR_ANOMALY -> CURRENT (captura un frame fresco). Mapeo fijo
 * en codigo, derivado unicamente de caseDetail.eventType (dato ya resuelto
 * por nuestro propio backend desde Hito 2); ninguna entrada MQTT puede
 * influir en esta eleccion.
 */
const CAPTURE_BY_EVENT_TYPE: Record<
  AnomalyDetectedEventDetail["eventType"],
  { reason: "LOCAL_VISUAL_ANOMALY" | "SENSOR_ANOMALY"; captureMode: "BUFFERED" | "CURRENT" }
> = {
  VISUAL_ANOMALY: { reason: "LOCAL_VISUAL_ANOMALY", captureMode: "BUFFERED" },
  SENSOR_ANOMALY: { reason: "SENSOR_ANOMALY", captureMode: "CURRENT" },
};

function mintS3Key(recipientId: string, caseId: string, imageId: string): string {
  return `raw-images/${recipientId}/${caseId}/${imageId}.jpg`;
}

export interface RequestEvidenceUploadInput extends CaseTaskInput {
  taskToken: string;
}

export async function handler(input: RequestEvidenceUploadInput): Promise<void> {
  const { caseDetail, taskToken } = input;
  const { reason, captureMode } = CAPTURE_BY_EVENT_TYPE[caseDetail.eventType];

  const result = await prepareUploadCommand(
    config.evidenceCallbacksTableName,
    {
      caseId: caseDetail.caseId,
      deviceId: caseDetail.deviceId,
      recipientId: caseDetail.recipientId,
      reason,
      captureMode,
      commandTimeoutSeconds: config.evidenceTimeoutSeconds,
      ttlBufferSeconds: config.ttlBufferSeconds,
    },
    taskToken,
    mintS3Key,
  );

  if (result.action === "NOOP") {
    return;
  }

  if (result.action === "RESOLVE_IMMEDIATELY") {
    // Reintento tardio: el caso ya se resolvio en un intento anterior.
    // Resolvemos el token de ESTA invocacion sin tocar la tabla (nunca se
    // escribe taskToken fuera de PENDING/ACK_ACCEPTED).
    await resolveTaskToken(taskToken, result.outcomeType, result.reason);
    return;
  }

  const uploadUrl = await presignEvidenceUpload(
    config.evidenceBucketName,
    result.s3Key,
    config.evidenceTimeoutSeconds,
  );

  await publishUploadEvidenceCommand(caseDetail.deviceId, {
    commandId: result.commandId,
    caseId: caseDetail.caseId,
    command: "UPLOAD_EVIDENCE",
    reason,
    captureMode,
    s3Key: result.s3Key,
    uploadUrl,
    expiresAt: result.commandExpiresAt,
  });

  await writeEvidenceEventLog(config.eventLogTableName, {
    caseId: caseDetail.caseId,
    eventType: "EVIDENCE_REQUESTED",
    deviceId: caseDetail.deviceId,
    recipientId: caseDetail.recipientId,
    commandId: result.commandId,
    s3Key: result.s3Key,
    imageId: result.imageId,
  });
}
