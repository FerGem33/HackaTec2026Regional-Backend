import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  ConverseCommand,
  ValidationException,
  AccessDeniedException,
  ResourceNotFoundException,
} from "@aws-sdk/client-bedrock-runtime";
import { requireEnv, requirePositiveInt, requireTemperature } from "./env.js";
import { s3, bedrockRuntime } from "./clients.js";
import { writeAnalysisEventLog } from "./eventLog.js";
import { buildConverseInput, buildUserContextText, extractResponseText, stripMarkdownFence } from "./bedrockPrompt.js";
import { isValidEvidenceObservation } from "./observationSchema.js";
import type { AnalysisFailureReason, AnalysisResult, AnalyzeEvidenceInput } from "./types.js";

const config = {
  evidenceBucketName: requireEnv("EVIDENCE_BUCKET_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  modelId: requireEnv("BEDROCK_MODEL_ID"),
  maxTokens: requirePositiveInt("BEDROCK_MAX_TOKENS", 400),
  temperature: requireTemperature("BEDROCK_TEMPERATURE", 0),
  maxImageBytes: requirePositiveInt("EVIDENCE_MAX_BYTES", 1_048_576),
};

// raw-images/{recipientId}/{caseId}/{imageId}.jpg -- misma forma que
// packages/contracts/schemas/uploadEvidenceCommand.schema.json#s3Key.
const S3_KEY_PATTERN =
  /^raw-images\/[a-z0-9-]{1,64}\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\.jpg$/;

function uncertain(failureReason: AnalysisFailureReason): AnalysisResult {
  return { analysisStatus: "UNCERTAIN", observation: null, failureReason };
}

/**
 * Mismo mapeo fijo que services/evidence/src/requestEvidenceUploadFn.ts
 * (CAPTURE_BY_EVENT_TYPE): VISUAL_ANOMALY -> BUFFERED, SENSOR_ANOMALY ->
 * CURRENT. Se deriva de caseDetail.eventType (ya resuelto por el backend),
 * nunca de una entrada externa.
 */
function captureModeFor(eventType: AnalyzeEvidenceInput["caseDetail"]["eventType"]): "BUFFERED" | "CURRENT" {
  return eventType === "SENSOR_ANOMALY" ? "CURRENT" : "BUFFERED";
}

/**
 * Verificacion propia, independiente de lo que el payload de Step
 * Functions afirme: el caseId/imageId embebidos en evidenceS3Key deben
 * coincidir exactamente con caseDetail.caseId/evidenceImageId. Defensa en
 * profundidad (nunca confiar ciegamente en el propio estado de la
 * ejecucion) antes de tocar S3 o Bedrock.
 */
function isConsistentS3Key(input: AnalyzeEvidenceInput): boolean {
  const match = S3_KEY_PATTERN.exec(input.evidenceS3Key);
  if (!match) {
    return false;
  }
  const [, caseIdInPath, imageIdInPath] = match;
  return caseIdInPath === input.caseDetail.caseId && imageIdInPath === input.evidenceImageId;
}

export async function handler(input: AnalyzeEvidenceInput): Promise<AnalysisResult> {
  if (!isConsistentS3Key(input)) {
    return uncertain("INTERNAL_ERROR");
  }

  const head = await s3
    .send(new HeadObjectCommand({ Bucket: config.evidenceBucketName, Key: input.evidenceS3Key }))
    .catch(() => undefined);
  const isValidImage =
    head !== undefined &&
    head.ContentType === "image/jpeg" &&
    (head.ContentLength ?? 0) > 0 &&
    (head.ContentLength ?? Number.POSITIVE_INFINITY) <= config.maxImageBytes;
  if (!isValidImage) {
    return uncertain("INTERNAL_ERROR");
  }

  await writeAnalysisEventLog(config.eventLogTableName, {
    caseId: input.caseDetail.caseId,
    eventType: "ANALYSIS_REQUESTED",
    imageId: input.evidenceImageId,
    s3Key: input.evidenceS3Key,
  });

  const object = await s3.send(
    new GetObjectCommand({ Bucket: config.evidenceBucketName, Key: input.evidenceS3Key }),
  );
  const imageBytes = await object.Body?.transformToByteArray();
  if (imageBytes === undefined) {
    return uncertain("INTERNAL_ERROR");
  }

  let response;
  try {
    response = await bedrockRuntime.send(
      new ConverseCommand(
        buildConverseInput({
          modelId: config.modelId,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          imageBytes,
          contextText: buildUserContextText(
            input.caseDetail.anomalyType,
            captureModeFor(input.caseDetail.eventType),
          ),
        }),
      ),
    );
  } catch (error) {
    // No reintentables: se atrapan aqui y NUNCA llegan a Step Functions
    // como excepcion (ver infra/lib/constructs/case-orchestration.ts,
    // Retry solo cubre Throttling/Timeout/ServiceUnavailable/InternalServer/
    // ModelError). Cualquier otra excepcion (throttling, timeout,
    // unavailable, internal) se relanza a proposito para que Step
    // Functions reintente la invocacion completa.
    if (error instanceof AccessDeniedException || error instanceof ResourceNotFoundException) {
      return uncertain("MODEL_UNAVAILABLE");
    }
    if (error instanceof ValidationException) {
      return uncertain("INTERNAL_ERROR");
    }
    throw error;
  }

  const rawText = extractResponseText(response);
  if (rawText === undefined) {
    return uncertain("INVALID_OUTPUT");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(rawText));
  } catch {
    return uncertain("INVALID_OUTPUT");
  }

  if (!isValidEvidenceObservation(parsed)) {
    return uncertain("INVALID_OUTPUT");
  }

  return { analysisStatus: "COMPLETED", observation: parsed, failureReason: null };
}
