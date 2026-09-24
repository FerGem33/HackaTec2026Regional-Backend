import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { validateEvidenceResult } from "@sensecare/contracts";
import { requireEnv, requirePositiveInt } from "./env.js";
import { extractMqttDeviceId } from "./envelope.js";
import { getCallback } from "./callbackStore.js";
import { resolveWithLease } from "./tokenResolution.js";
import { s3 } from "./clients.js";

const config = {
  evidenceCallbacksTableName: requireEnv("EVIDENCE_CALLBACKS_TABLE_NAME"),
  evidenceBucketName: requireEnv("EVIDENCE_BUCKET_NAME"),
  resolutionLeaseSeconds: requirePositiveInt("RESOLUTION_LEASE_SECONDS", 30),
  maxEvidenceBytes: requirePositiveInt("EVIDENCE_MAX_BYTES", 1_048_576),
};

interface HeadInfo {
  contentType?: string;
  contentLength?: number;
}

async function headObjectOrUndefined(key: string): Promise<HeadInfo | undefined> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.evidenceBucketName, Key: key }));
    return { contentType: head.ContentType, contentLength: head.ContentLength };
  } catch {
    return undefined; // 404 u otro error: tratado como objeto ausente
  }
}

async function deleteInvalidObjectBestEffort(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.evidenceBucketName, Key: key }));
  } catch (error) {
    console.warn("evidenceCallbackHandlerFn: no se pudo limpiar objeto invalido", {
      key,
      error: error instanceof Error ? error.message : error,
    });
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const { mqttDeviceId, payload } = extractMqttDeviceId(record.body);
      if (!validateEvidenceResult(payload)) {
        throw new Error(`Resultado de evidencia invalido: ${JSON.stringify(validateEvidenceResult.errors)}`);
      }

      const callback = await getCallback(config.evidenceCallbacksTableName, payload.caseId);
      if (!callback) {
        throw new Error(`EvidenceCallbacks no encontrado para caseId=${payload.caseId}`);
      }
      if (callback.deviceId !== mqttDeviceId) {
        throw new Error("mqttDeviceId no coincide con el deviceId registrado para este caso");
      }
      if (callback.commandId !== payload.commandId) {
        throw new Error("commandId no coincide con el comando pendiente registrado");
      }
      if (callback.status === "RESOLVED") {
        // Reenvio/reinicio de la Pi con un resultado ya conocido: no volver
        // a verificar el objeto ni a intentar el lease.
        continue;
      }
      if (Date.now() >= Date.parse(callback.commandExpiresAt)) {
        continue; // expirado: el timeout de Step Functions decide
      }

      if (payload.eventType === "EVIDENCE_FAILED") {
        await resolveWithLease(
          config.evidenceCallbacksTableName,
          payload.caseId,
          payload.commandId,
          config.resolutionLeaseSeconds,
          "UPLOAD_FAILED",
          undefined,
          payload.errorCode,
        );
        continue;
      }

      // EVIDENCE_UPLOADED: verificar que el objeto esperado es exactamente
      // el que se pidio, que existe, y que cumple tipo/tamano acordados.
      if (payload.s3Key !== callback.expectedS3Key || payload.imageId !== callback.imageId) {
        await resolveWithLease(
          config.evidenceCallbacksTableName,
          payload.caseId,
          payload.commandId,
          config.resolutionLeaseSeconds,
          "OBJECT_INVALID",
          undefined,
          "S3_KEY_OR_IMAGE_ID_MISMATCH",
        );
        continue;
      }

      const head = await headObjectOrUndefined(payload.s3Key);
      const isValid =
        head !== undefined &&
        head.contentType === "image/jpeg" &&
        (head.contentLength ?? 0) > 0 &&
        (head.contentLength ?? Number.POSITIVE_INFINITY) <= config.maxEvidenceBytes;

      if (!isValid) {
        if (head !== undefined) {
          await deleteInvalidObjectBestEffort(payload.s3Key);
        }
        await resolveWithLease(
          config.evidenceCallbacksTableName,
          payload.caseId,
          payload.commandId,
          config.resolutionLeaseSeconds,
          head === undefined ? "OBJECT_MISSING" : "OBJECT_INVALID",
          undefined,
          head === undefined ? "OBJECT_MISSING" : "OBJECT_INVALID",
        );
        continue;
      }

      await resolveWithLease(
        config.evidenceCallbacksTableName,
        payload.caseId,
        payload.commandId,
        config.resolutionLeaseSeconds,
        "UPLOADED",
        { outcome: "UPLOADED", s3Key: payload.s3Key, imageId: payload.imageId, commandId: payload.commandId },
        undefined,
      );
    } catch (error) {
      console.error("evidenceCallbackHandlerFn: fallo procesando registro", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : error,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
