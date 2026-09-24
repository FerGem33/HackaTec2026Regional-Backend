import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { createHash } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { UpdateEndpointCommand } from "@aws-sdk/client-pinpoint";
import { ddb, pinpoint } from "./clients.js";
import { registerPushDeviceConfig } from "./registerPushDeviceConfig.js";
import { getUserId } from "./authContext.js";

const SUPPORTED_PLATFORMS = new Set(["android"]);

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface RegisterPushDeviceBody {
  platform?: unknown;
  token?: unknown;
}

/**
 * POST /me/push-devices -- registra el token FCM del dispositivo del
 * usuario autenticado como un endpoint de Amazon Pinpoint (canal GCM, ver
 * PushApplication). `userId` sale SIEMPRE del JWT (nunca del body): un
 * cliente no puede registrar un push a nombre de otro usuario. Solo
 * Android/FCM en este hito.
 *
 * `endpointId` es determinista: sha256(userId + token), nunca generado al
 * azar. Esto hace que registrar el MISMO token dos veces (reinicio de la
 * app, doble tap del boton de login) sea naturalmente idempotente -- se
 * actualiza el mismo endpoint en Pinpoint y la misma fila en DynamoDB, sin
 * necesitar una consulta previa para "encontrar si ya existe".
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) {
    return jsonResponse(401, { error: "Token sin sub valido" });
  }

  let body: RegisterPushDeviceBody;
  try {
    body = event.body ? (JSON.parse(event.body) as RegisterPushDeviceBody) : {};
  } catch {
    return jsonResponse(400, { error: "Body invalido: se esperaba JSON" });
  }

  const { platform, token } = body;
  if (typeof platform !== "string" || !SUPPORTED_PLATFORMS.has(platform)) {
    return jsonResponse(400, { error: `platform debe ser uno de: ${[...SUPPORTED_PLATFORMS].join(", ")}` });
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    return jsonResponse(400, { error: "token es requerido" });
  }

  const endpointId = deriveEndpointId(userId, token);

  try {
    await pinpoint.send(
      new UpdateEndpointCommand({
        ApplicationId: registerPushDeviceConfig.pinpointApplicationId,
        EndpointId: endpointId,
        EndpointRequest: {
          ChannelType: "GCM",
          Address: token,
          EndpointStatus: "ACTIVE",
          User: { UserId: userId },
        },
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "register_push_device_pinpoint_failed",
        userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse(502, { error: "No se pudo registrar el dispositivo con el proveedor de push" });
  }

  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: registerPushDeviceConfig.caregiverPushEndpointsTableName,
      Key: { userId, endpointId },
      UpdateExpression:
        "SET platform = :platform, #status = :active, pushConsent = :true, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":platform": platform,
        ":active": "ACTIVE",
        ":true": true,
        ":now": now,
      },
    }),
  );

  return jsonResponse(200, { endpointId });
}

function deriveEndpointId(userId: string, token: string): string {
  return createHash("sha256").update(`${userId}:${token}`).digest("hex");
}
