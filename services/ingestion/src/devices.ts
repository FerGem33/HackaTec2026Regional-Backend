import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";
import { config } from "./config.js";
import { DeviceNotFoundError } from "./errors.js";

interface DeviceRecord {
  deviceId: string;
  recipientId: string;
}

/**
 * Unica fuente de verdad para recipientId. Un payload de telemetria o
 * anomalia proveniente del edge NUNCA debe usarse para obtener
 * recipientId (el schema ya lo prohibe con additionalProperties:false);
 * este helper es el unico camino soportado para resolverlo.
 */
export async function resolveRecipientId(deviceId: string): Promise<string> {
  const result = await ddb.send(
    new GetCommand({
      TableName: config.devicesTableName,
      Key: { deviceId },
      ProjectionExpression: "recipientId",
    }),
  );

  const item = result.Item as DeviceRecord | undefined;
  if (!item?.recipientId) {
    throw new DeviceNotFoundError(deviceId);
  }
  return item.recipientId;
}

/**
 * Actualiza lastSeenAt solo si el evento es mas reciente que el ultimo
 * registrado. Las colas SQS Standard no garantizan orden de entrega, asi
 * que un mensaje atrasado no debe pisar un estado mas nuevo.
 */
export async function touchDeviceLastSeen(
  deviceId: string,
  occurredAt: string,
  eventId: string,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.devicesTableName,
        Key: { deviceId },
        UpdateExpression: "SET lastSeenAt = :occurredAt, lastTelemetryEventId = :eventId",
        ConditionExpression: "attribute_not_exists(lastSeenAt) OR lastSeenAt < :occurredAt",
        ExpressionAttributeValues: { ":occurredAt": occurredAt, ":eventId": eventId },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return; // mensaje atrasado respecto al ultimo estado conocido: no-op
    }
    throw error;
  }
}
