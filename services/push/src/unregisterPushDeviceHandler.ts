import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteEndpointCommand, NotFoundException } from "@aws-sdk/client-pinpoint";
import { ddb, pinpoint } from "./clients.js";
import { unregisterPushDeviceConfig } from "./unregisterPushDeviceConfig.js";
import { getUserId } from "./authContext.js";

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * DELETE /me/push-devices/{endpointId} -- da de baja un endpoint de push
 * del usuario autenticado. Verifica ownership por `userId` ANTES de tocar
 * Pinpoint o borrar la fila: un usuario nunca puede borrar el endpoint de
 * otro aunque adivine su `endpointId` (hash sha256 no reversible, pero el
 * chequeo existe de todas formas, mismo principio que caseAccess.ts).
 *
 * `mobiletargeting:DeleteEndpoint` sobre un endpoint que ya no existe en
 * Pinpoint (p. ej. borrado manual, o `PERMANENT_FAILURE` marcado por
 * dispatchPushFn) no debe fallar la baja local: el objetivo final -- que
 * esta fila desaparezca -- se cumple igual.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) {
    return jsonResponse(401, { error: "Token sin sub valido" });
  }

  const endpointId = event.pathParameters?.endpointId;
  if (!endpointId) {
    return jsonResponse(400, { error: "Falta endpointId en la ruta" });
  }

  const existing = await ddb.send(
    new GetCommand({
      TableName: unregisterPushDeviceConfig.caregiverPushEndpointsTableName,
      Key: { userId, endpointId },
      ConsistentRead: true,
    }),
  );
  if (!existing.Item) {
    return jsonResponse(404, { error: "Dispositivo no encontrado" });
  }

  try {
    await pinpoint.send(
      new DeleteEndpointCommand({
        ApplicationId: unregisterPushDeviceConfig.pinpointApplicationId,
        EndpointId: endpointId,
      }),
    );
  } catch (error) {
    if (!(error instanceof NotFoundException)) {
      console.error(
        JSON.stringify({
          event: "unregister_push_device_pinpoint_failed",
          userId,
          endpointId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return jsonResponse(502, { error: "No se pudo dar de baja el dispositivo con el proveedor de push" });
    }
  }

  await ddb.send(
    new DeleteCommand({
      TableName: unregisterPushDeviceConfig.caregiverPushEndpointsTableName,
      Key: { userId, endpointId },
    }),
  );

  return jsonResponse(200, { endpointId, deleted: true });
}
