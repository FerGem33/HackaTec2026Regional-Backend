import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { validateCommandAck } from "@sensecare/contracts";
import { requireEnv, requirePositiveInt } from "./env.js";
import { extractMqttDeviceId } from "./envelope.js";
import { getCallback, markAckAccepted } from "./callbackStore.js";
import { resolveWithLease } from "./tokenResolution.js";
import { writeEvidenceEventLog } from "./eventLog.js";

const config = {
  evidenceCallbacksTableName: requireEnv("EVIDENCE_CALLBACKS_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  resolutionLeaseSeconds: requirePositiveInt("RESOLUTION_LEASE_SECONDS", 30),
};

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const { mqttDeviceId, payload } = extractMqttDeviceId(record.body);
      if (!validateCommandAck(payload)) {
        throw new Error(`COMMAND_ACK invalido: ${JSON.stringify(validateCommandAck.errors)}`);
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
        // Reenvio/reinicio de la Pi con un resultado ya conocido: no
        // repetir ningun trabajo (ni siquiera intentar el lease).
        continue;
      }
      if (Date.now() >= Date.parse(callback.commandExpiresAt)) {
        // Expirado: no forzar SendTaskFailure aqui; el timeout de Step
        // Functions es quien decide INCOMPLETE. Se ignora sin error.
        continue;
      }

      if (payload.accepted) {
        // accepted:true confirma recepcion, pero NO termina la orden.
        await markAckAccepted(config.evidenceCallbacksTableName, payload.caseId, payload.commandId);
        await writeEvidenceEventLog(config.eventLogTableName, {
          caseId: payload.caseId,
          eventType: "EVIDENCE_ACKNOWLEDGED",
          commandId: payload.commandId,
        });
        continue;
      }

      // accepted:false SI termina la orden de inmediato.
      const outcome = await resolveWithLease(
        config.evidenceCallbacksTableName,
        payload.caseId,
        payload.commandId,
        config.resolutionLeaseSeconds,
        "REJECTED",
        undefined,
        payload.reason,
      );
      if (outcome === "RESOLVED") {
        await writeEvidenceEventLog(config.eventLogTableName, {
          caseId: payload.caseId,
          eventType: "EVIDENCE_REJECTED",
          commandId: payload.commandId,
          reason: payload.reason,
        });
      }
    } catch (error) {
      console.error("commandAckHandlerFn: fallo procesando registro", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : error,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
