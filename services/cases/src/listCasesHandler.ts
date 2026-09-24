import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { listCasesConfig } from "./listCasesConfig.js";
import { getUserId } from "./authContext.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface CaseSummary {
  caseId: string;
  deviceId: string;
  eventType: string;
  anomalyType: string;
  severity?: string;
  status?: string;
  alertStatus?: string;
  evidenceStatus?: string;
  analysisStatus?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * GET /cases -- historial de casos de TODOS los deviceId que el usuario
 * autenticado tiene emparejados (CaregiverAccess), fusionado y ordenado por
 * createdAt desc. Complementa a GET /cases/{caseId}/events (linea de
 * tiempo de UN caso puntual, que exige conocer su caseId de antemano): esta
 * ruta es la vista de lista que un simulador/app movil necesita para
 * pintar "historial de alertas" sin conocer ningun caseId todavia.
 *
 * Sin CaregiverAccess -> lista vacia (200), nunca 403: a diferencia de
 * /cases/{caseId}/events, esta ruta no es por-recurso, es por-usuario, y
 * "no tengo ningun dispositivo emparejado todavia" es un estado valido, no
 * un error de autorizacion.
 *
 * Solo campos saneados (ver AnomalyCasesByDevice en
 * infra/lib/constructs/anomaly-cases-table.ts): nunca evidenceS3Key,
 * evidenceImageId ni observaciones de Bedrock.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) {
    return jsonResponse(401, { error: "Token sin sub valido" });
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

  const deviceIds = await listAuthorizedDeviceIds(userId);
  if (deviceIds.length === 0) {
    return jsonResponse(200, { count: 0, items: [] });
  }

  const perDeviceResults = await Promise.all(deviceIds.map((deviceId) => queryCasesForDevice(deviceId, limit)));

  const merged = perDeviceResults
    .flat()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);

  return jsonResponse(200, { count: merged.length, items: merged });
}

async function listAuthorizedDeviceIds(userId: string): Promise<string[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: listCasesConfig.caregiverAccessTableName,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
      ProjectionExpression: "deviceId",
    }),
  );
  return (result.Items ?? []).map((item) => item.deviceId as string);
}

async function queryCasesForDevice(deviceId: string, limit: number): Promise<CaseSummary[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: listCasesConfig.anomalyCasesTableName,
      IndexName: "AnomalyCasesByDevice",
      KeyConditionExpression: "deviceId = :deviceId",
      ExpressionAttributeValues: { ":deviceId": deviceId },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as CaseSummary[];
}
