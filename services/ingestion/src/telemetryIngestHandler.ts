import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { validateTelemetry } from "@sensecare/contracts";
import { ddb } from "./clients.js";
import { config } from "./config.js";
import { resolveRecipientId, touchDeviceLastSeen } from "./devices.js";
import { extractVerifiedPayload } from "./envelope.js";

function computeTtl(occurredAt: string): number {
  const occurredAtMs = Date.parse(occurredAt);
  return Math.floor(occurredAtMs / 1000) + config.telemetryRetentionDays * 24 * 60 * 60;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      // Separa y verifica mqttDeviceId (topic(4) de la IoT Rule) contra
      // payload.deviceId ANTES de validar el schema; ver envelope.ts.
      const payload: unknown = extractVerifiedPayload(record.body);
      if (!validateTelemetry(payload)) {
        throw new Error(`Telemetry invalida: ${JSON.stringify(validateTelemetry.errors)}`);
      }

      // resolveRecipientId es la unica fuente de recipientId; el payload
      // del edge nunca trae ese campo (el schema lo prohibe).
      const recipientId = await resolveRecipientId(payload.deviceId);

      try {
        await ddb.send(
          new PutCommand({
            TableName: config.telemetryTableName,
            Item: {
              ...payload,
              deviceId: payload.deviceId,
              occurredAtEventId: `${payload.occurredAt}#${payload.eventId}`,
              recipientId,
              receivedAt: new Date().toISOString(),
              expiresAt: computeTtl(payload.occurredAt),
            },
            ConditionExpression: "attribute_not_exists(deviceId)",
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
        // eventId ya persistido (redelivery de SQS): no-op idempotente.
      }

      await touchDeviceLastSeen(payload.deviceId, payload.occurredAt, payload.eventId);
    } catch (error) {
      console.error("telemetryIngestHandler: fallo procesando registro", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : error,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
