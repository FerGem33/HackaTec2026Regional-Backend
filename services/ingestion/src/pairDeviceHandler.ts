import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { queryConfig } from "./queryConfig.js";
import { grantDeviceAccess } from "./caregiverAccess.js";
import { getUserId } from "./authContext.js";

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * POST /devices/{deviceId}/pair -- el QR fisico (Pi) o en pantalla
 * (simulador) codifica {deviceId, pairingCode}; escanearlo solo revela
 * esos dos valores, nunca credenciales. Este endpoint es el UNICO lugar
 * donde pairingCode se compara contra el valor guardado en Devices; si
 * coincide, otorga acceso de lectura a este usuario (el `sub` de su JWT)
 * para este deviceId via CaregiverAccess. Sin este paso, GET
 * /devices/{deviceId}/latest y /telemetry responden 403 para ese usuario,
 * sin importar que su JWT sea valido para OTRO deviceId que si emparejo.
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
    // No deberia pasar nunca (el authorizer JWT exige un token valido
    // antes de invocar este Lambda), pero no asumir forma de claims ajena.
    return jsonResponse(401, { error: "Token sin sub valido" });
  }

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : undefined;
  } catch {
    return jsonResponse(400, { error: "Cuerpo JSON invalido" });
  }

  const providedCode = (body as { pairingCode?: unknown } | undefined)?.pairingCode;
  if (typeof providedCode !== "string" || providedCode.trim().length === 0) {
    return jsonResponse(400, { error: "Falta pairingCode en el cuerpo" });
  }

  const deviceResult = await ddb.send(
    new GetCommand({
      TableName: queryConfig.devicesTableName,
      Key: { deviceId },
      ProjectionExpression: "pairingCode",
    }),
  );

  const storedCode = deviceResult.Item?.pairingCode as string | undefined;
  if (!storedCode) {
    return jsonResponse(404, { error: "Dispositivo no encontrado" });
  }

  // Normalizado a mayusculas/trim en ambos lados: el codigo esta pensado
  // para poder escribirse a mano como respaldo si falla la camara del QR.
  if (storedCode.trim().toUpperCase() !== providedCode.trim().toUpperCase()) {
    return jsonResponse(403, { error: "Codigo de emparejamiento invalido" });
  }

  await grantDeviceAccess(userId, deviceId);

  return jsonResponse(200, { paired: true, deviceId });
}
