import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { getDeviceLatest } from "./deviceQueryCore.js";
import { hasDeviceAccess } from "./caregiverAccess.js";
import { getUserId } from "./authContext.js";

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * GET /devices/{deviceId}/latest -- panel de valores en vivo (simulador y
 * app movil). Requiere que el usuario del JWT ya haya emparejado este
 * deviceId via POST /devices/{deviceId}/pair; un JWT valido para OTRO
 * deviceId no basta (ver caregiverAccess.ts).
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

  const result = await getDeviceLatest(deviceId);
  return jsonResponse(200, result);
}
