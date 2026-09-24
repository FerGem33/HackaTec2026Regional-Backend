import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { casesConfig } from "./casesConfig.js";
import { getCase, hasDeviceAccess } from "./caseAccess.js";
import { getUserId } from "./authContext.js";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * GET /cases/{caseId}/events -- linea de tiempo auditada del caso
 * (EventLog), para el familiar/CLI de demo. El 403 se responde ANTES de
 * tocar EventLog: la autorizacion nunca deja pasar datos del caso primero.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const caseId = event.pathParameters?.caseId;
  if (!caseId) {
    return jsonResponse(400, { error: "Falta caseId en la ruta" });
  }

  const userId = getUserId(event);
  if (!userId) {
    return jsonResponse(401, { error: "Token sin sub valido" });
  }

  const caseItem = await getCase(caseId);
  if (!caseItem) {
    // Un caseId es un UUID no adivinable: no hay nada sensible que ocultar
    // detras de un 403 generico aqui.
    return jsonResponse(404, { error: "Caso no encontrado" });
  }

  if (!(await hasDeviceAccess(userId, caseItem.deviceId))) {
    return jsonResponse(403, { error: "No tienes acceso a este caso" });
  }

  const qs = event.queryStringParameters ?? {};
  let limit = DEFAULT_LIMIT;
  if (qs.limit !== undefined) {
    const parsed = Number(qs.limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return jsonResponse(400, { error: "limit debe ser un entero positivo" });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: casesConfig.eventLogTableName,
      KeyConditionExpression: "caseId = :caseId",
      ExpressionAttributeValues: { ":caseId": caseId },
      ScanIndexForward: true,
      Limit: limit,
    }),
  );

  return jsonResponse(200, { caseId, count: result.Items?.length ?? 0, items: result.Items ?? [] });
}
