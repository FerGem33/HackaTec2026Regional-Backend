import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { casesConfig } from "./casesConfig.js";

export interface CaseRecord {
  caseId: string;
  deviceId: string;
  recipientId: string;
  anomalyType: string;
  eventType: string;
  alertStatus?: string;
}

export async function getCase(caseId: string): Promise<CaseRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: casesConfig.anomalyCasesTableName,
      Key: { caseId },
    }),
  );
  return result.Item as CaseRecord | undefined;
}

/**
 * Misma verificacion que services/ingestion/src/caregiverAccess.ts
 * (hasDeviceAccess), duplicada a proposito (ver casesConfig.ts).
 * ConsistentRead: true porque es un chequeo de autorizacion, no un panel de
 * metricas -- un emparejamiento reciente debe ser visible de inmediato.
 */
export async function hasDeviceAccess(userId: string, deviceId: string): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: casesConfig.caregiverAccessTableName,
      Key: { userId, deviceId },
      ConsistentRead: true,
    }),
  );
  return result.Item !== undefined;
}
