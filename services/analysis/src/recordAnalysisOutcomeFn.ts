import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { requireEnv, requirePositiveInt, requireTemperature } from "./env.js";
import { writeAnalysisEventLog } from "./eventLog.js";
import type { CaseTaskInput, RecordAnalysisOutcomeInput } from "./types.js";

const config = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  observationsTableName: requireEnv("OBSERVATIONS_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  // Solo para dejar constancia de procedencia en Observations (nunca se
  // llama a Bedrock desde aqui); mismos valores que analyzeEvidenceFn.
  modelId: requireEnv("BEDROCK_MODEL_ID"),
  maxTokens: requirePositiveInt("BEDROCK_MAX_TOKENS", 400),
  temperature: requireTemperature("BEDROCK_TEMPERATURE", 0),
};

// Mismo horizonte que el lifecycle de S3 de raw-images/ (7 dias, ver
// infra/lib/constructs/evidence-bucket.ts): el resumen narrativo en
// Observations no deberia sobrevivir a la foto que lo origino. Los campos
// cerrados/estructurados equivalentes se copian ademas a AnomalyCases, que
// si es permanente.
const OBSERVATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Unico lugar que escribe en Observations y que actualiza
 * AnomalyCases.analysisStatus. Nunca toca AnomalyCases.status (el caso
 * permanece abierto; cerrar/escalar es un hito posterior) ni
 * evidenceStatus (permanece AVAILABLE sin importar el resultado del
 * analisis).
 *
 * Idempotente ante redelivery de Step Functions (retryOnServiceExceptions):
 * un reintento con el MISMO analysisResult sobrescribe la MISMA fila de
 * Observations (PK=caseId, SK=imageId) con los MISMOS valores -- nunca crea
 * una segunda fila ni dos resultados COMPLETED distintos para el mismo
 * caseId+imageId.
 */
export async function handler(input: RecordAnalysisOutcomeInput): Promise<CaseTaskInput> {
  const now = new Date().toISOString();
  const { caseDetail } = input;

  if (input.analysisStatus === "COMPLETED") {
    const { observation } = input;

    await ddb.send(
      new PutCommand({
        TableName: config.observationsTableName,
        Item: {
          caseId: caseDetail.caseId,
          imageId: input.evidenceImageId,
          recipientId: caseDetail.recipientId,
          s3Key: input.evidenceS3Key,
          personDetected: observation.personDetected,
          posture: observation.posture,
          riskIndicators: observation.riskIndicators,
          needsHumanReview: observation.needsHumanReview,
          confidence: observation.confidence,
          summary: observation.summary,
          modelId: config.modelId,
          bedrockConfig: { maxTokens: config.maxTokens, temperature: config.temperature },
          createdAt: now,
          ttlEpochSeconds: Math.floor(Date.now() / 1000) + OBSERVATION_TTL_SECONDS,
        },
      }),
    );

    await ddb.send(
      new UpdateCommand({
        TableName: config.anomalyCasesTableName,
        Key: { caseId: caseDetail.caseId },
        UpdateExpression:
          "SET analysisStatus = :status, analysisRiskIndicators = :riskIndicators, " +
          "analysisNeedsHumanReview = :needsHumanReview, analysisConfidence = :confidence, " +
          "analysisObservationImageId = :imageId, updatedAt = :now",
        ExpressionAttributeValues: {
          ":status": input.analysisStatus,
          ":riskIndicators": observation.riskIndicators,
          ":needsHumanReview": observation.needsHumanReview,
          ":confidence": observation.confidence,
          ":imageId": input.evidenceImageId,
          ":now": now,
        },
      }),
    );

    // Nunca `summary` (texto libre) en EventLog: solo IDs, enums cerrados y
    // booleanos, igual que el resto de la auditoria del sistema.
    await writeAnalysisEventLog(config.eventLogTableName, {
      caseId: caseDetail.caseId,
      eventType: "ANALYSIS_COMPLETED",
      imageId: input.evidenceImageId,
      s3Key: input.evidenceS3Key,
      riskIndicators: observation.riskIndicators,
      needsHumanReview: observation.needsHumanReview,
    });

    return { caseDetail, executionArn: input.executionArn };
  }

  await ddb.send(
    new UpdateCommand({
      TableName: config.anomalyCasesTableName,
      Key: { caseId: caseDetail.caseId },
      UpdateExpression: "SET analysisStatus = :status, analysisFailureReason = :reason, updatedAt = :now",
      ExpressionAttributeValues: {
        ":status": input.analysisStatus,
        ":reason": input.failureReason,
        ":now": now,
      },
    }),
  );

  await writeAnalysisEventLog(config.eventLogTableName, {
    caseId: caseDetail.caseId,
    eventType: "ANALYSIS_UNCERTAIN",
    imageId: input.evidenceImageId,
    s3Key: input.evidenceS3Key,
    failureReason: input.failureReason,
  });

  return { caseDetail, executionArn: input.executionArn };
}
