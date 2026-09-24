import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { getDeviceLatest } from "./deviceQueryCore.js";

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** GET /devices/{deviceId}/latest -- panel de valores en vivo (simulador y app movil). */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const deviceId = event.pathParameters?.deviceId;
  if (!deviceId) {
    return jsonResponse(400, { error: "Falta deviceId en la ruta" });
  }

  const result = await getDeviceLatest(deviceId);
  return jsonResponse(200, result);
}
