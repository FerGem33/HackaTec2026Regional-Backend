import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { queryConfig } from "./queryConfig.js";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export interface DeviceLatestResult {
  deviceId: string;
  lastSeenAt: string | null;
  latestTelemetry: Record<string, unknown> | null;
}

/**
 * No filtra por ningun allowlist de deviceId: a diferencia del endpoint de
 * ingesta (que SI restringe que solo deviceId de demo puedan escribir por
 * HTTPS), la lectura es igual de valida para pi-demo-01 (dispositivo fisico
 * real, llega por MQTT) que para sim-room-01 (simulador web, llega por este
 * mismo API). Autorizacion es unicamente "JWT valido" (API Gateway ya lo
 * exige antes de invocar este Lambda); no hay CaregiverAccess todavia (ver
 * TODO en sensecare-demo-stack.ts).
 */
export async function getDeviceLatest(deviceId: string): Promise<DeviceLatestResult> {
  const [deviceResult, telemetryResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: queryConfig.devicesTableName,
        Key: { deviceId },
        ProjectionExpression: "lastSeenAt",
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: queryConfig.telemetryTableName,
        KeyConditionExpression: "deviceId = :deviceId",
        ExpressionAttributeValues: { ":deviceId": deviceId },
        ScanIndexForward: false,
        Limit: 1,
      }),
    ),
  ]);

  return {
    deviceId,
    lastSeenAt: (deviceResult.Item?.lastSeenAt as string | undefined) ?? null,
    latestTelemetry: telemetryResult.Items?.[0] ?? null,
  };
}

export interface TelemetryRangeQuery {
  deviceId: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * occurredAtEventId = `${occurredAt}#${eventId}` (ver telemetryIngestHandler.ts).
 * Un ISO-8601 UTC es siempre el mismo largo y compara lexicograficamente
 * igual que cronologicamente, asi que Query puede usar `from`/`to` crudos
 * como limites de rango sin parsear fechas. El sufijo `#￿` en `to`
 * incluye cualquier eventId publicado exactamente en ese instante (de otro
 * modo, un `to` sin sufijo excluiria esa lectura: como string, el prefijo
 * "2026-09-24T00:00:00Z" ordena ANTES que "2026-09-24T00:00:00Z#unEventId").
 */
export async function getTelemetryRange(query: TelemetryRangeQuery): Promise<Record<string, unknown>[]> {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  let keyCondition = "deviceId = :deviceId";
  const values: Record<string, unknown> = { ":deviceId": query.deviceId };

  if (query.from && query.to) {
    keyCondition += " AND occurredAtEventId BETWEEN :from AND :to";
    values[":from"] = query.from;
    values[":to"] = `${query.to}#￿`;
  } else if (query.from) {
    keyCondition += " AND occurredAtEventId >= :from";
    values[":from"] = query.from;
  } else if (query.to) {
    keyCondition += " AND occurredAtEventId <= :to";
    values[":to"] = `${query.to}#￿`;
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: queryConfig.telemetryTableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ScanIndexForward: true,
      Limit: limit,
    }),
  );

  return result.Items ?? [];
}
