import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { queryConfig } from "./queryConfig.js";

/**
 * ConsistentRead: true a proposito -- esto es un chequeo de autorizacion,
 * no un panel de metricas. Un emparejamiento que se acaba de otorgar
 * (grantDeviceAccess) debe ser visible de inmediato en la siguiente
 * consulta de lectura, sin la ventana de replicacion eventual que DynamoDB
 * permite por defecto.
 */
export async function hasDeviceAccess(userId: string, deviceId: string): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: queryConfig.caregiverAccessTableName,
      Key: { userId, deviceId },
      ConsistentRead: true,
    }),
  );
  return result.Item !== undefined;
}

export async function grantDeviceAccess(userId: string, deviceId: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: queryConfig.caregiverAccessTableName,
      Item: { userId, deviceId, pairedAt: new Date().toISOString() },
    }),
  );
}
