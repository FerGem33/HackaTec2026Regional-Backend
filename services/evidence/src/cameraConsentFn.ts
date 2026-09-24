import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients.js";
import { requireEnv } from "./env.js";
import type { CaseTaskInput } from "./types.js";

const config = {
  devicesTableName: requireEnv("DEVICES_TABLE_NAME"),
};

interface DeviceRecord {
  deviceId: string;
  cameraConsent?: unknown;
}

/**
 * Task de Step Functions. cameraConsent === true (booleano estricto) es el
 * UNICO valor que permite solicitar evidencia; ausente, false o cualquier
 * dato invalido (string, numero, etc.) resulta en false -> SKIPPED_NO_CONSENT.
 */
export async function handler(input: CaseTaskInput): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: config.devicesTableName,
      Key: { deviceId: input.caseDetail.deviceId },
      ProjectionExpression: "cameraConsent",
    }),
  );

  const item = result.Item as DeviceRecord | undefined;
  return item?.cameraConsent === true;
}
