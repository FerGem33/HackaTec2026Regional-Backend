import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { getTelemetryRange } from "./deviceQueryCore.js";
import { hasDeviceAccess } from "./caregiverAccess.js";
import { getUserId } from "./authContext.js";

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * GET /devices/{deviceId}/telemetry?from=&to=&limit= -- historial para
 * graficas. Misma verificacion de emparejamiento que getDeviceLatestHandler.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const deviceId = event.pathParameters?.deviceId;
  if (!deviceId) {
    return jsonResponse(400, { error: "Falta deviceId en la ruta" });
  }

  const userId = getUserId(event);
  if (!userId) {
    return jsonResponse(401, { error: "Token sin sub valido" });
  }

  if (!(await hasDeviceAccess(userId, deviceId))) {
    return jsonResponse(403, {
      error: "No tienes acceso a este dispositivo. Empareja primero con POST /devices/{deviceId}/pair",
    });
  }

  const qs = event.queryStringParameters ?? {};

  if (qs.from !== undefined && !ISO_UTC_PATTERN.test(qs.from)) {
    return jsonResponse(400, { error: "from invalido, se espera ISO-8601 UTC (ej. 2026-09-24T00:00:00Z)" });
  }
  if (qs.to !== undefined && !ISO_UTC_PATTERN.test(qs.to)) {
    return jsonResponse(400, { error: "to invalido, se espera ISO-8601 UTC (ej. 2026-09-24T23:59:59Z)" });
  }

  let limit: number | undefined;
  if (qs.limit !== undefined) {
    limit = Number(qs.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      return jsonResponse(400, { error: "limit debe ser un entero positivo" });
    }
  }

  const items = await getTelemetryRange({ deviceId, from: qs.from, to: qs.to, limit });
  return jsonResponse(200, { deviceId, count: items.length, items });
}
