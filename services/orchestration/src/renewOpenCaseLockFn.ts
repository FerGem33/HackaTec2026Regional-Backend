import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";
import { config } from "./taskConfig.js";
import type { CaseTaskInput } from "./types.js";

/**
 * Task de Step Functions: renueva el TTL del candado que abrio este caso.
 * Solo renueva UNA vez, al iniciar la ejecucion (ver config.ts para el
 * porque). La condicion caseId=:caseId evita el problema ABA: si el lock
 * ya expiro y fue reabierto por una anomalia distinta con un caseId
 * nuevo, esta ejecucion NO debe extender el TTL de ese caso ajeno.
 *
 * Si el lock ya pertenece a otro caseId, se registra una advertencia
 * estructurada y la ejecucion CONTINUA hacia UpsertAnomalyCase: registrar
 * el caso importa mas que renovar el candado, y el candado ajeno sigue su
 * propio ciclo de vida sin interferencia de esta ejecucion.
 */
export async function handler(input: CaseTaskInput): Promise<CaseTaskInput> {
  const { caseDetail } = input;
  const lockKey = `${caseDetail.recipientId}#${caseDetail.anomalyType}`;
  const now = Math.floor(Date.now() / 1000);
  const newExpiresAt = now + config.openCaseLockTtlSeconds;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.openCaseLocksTableName,
        Key: { lockKey },
        UpdateExpression: "SET expiresAt = :newExpiresAt",
        ConditionExpression: "caseId = :caseId",
        ExpressionAttributeValues: { ":newExpiresAt": newExpiresAt, ":caseId": caseDetail.caseId },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      console.warn(
        JSON.stringify({
          event: "open_case_lock_renewal_skipped",
          reason: "lock_owned_by_different_case",
          lockKey,
          caseId: caseDetail.caseId,
        }),
      );
      return input;
    }
    throw error;
  }

  return input;
}
