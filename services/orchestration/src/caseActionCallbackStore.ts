import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "./clients.js";

export const HUMAN_DECISION_CALLBACK_TYPE = "HUMAN_DECISION" as const;

/**
 * Crea (o refresca, si Step Functions reintento la Task por una excepcion
 * transitoria del servicio Lambda) el registro PENDING del taskToken que
 * espera una decision humana. Mismo patron de "PENDING refresca token" que
 * services/evidence/src/callbackStore.ts::prepareUploadCommand: el
 * taskToken puede cambiar entre reintentos de la MISMA Task; el commandId
 * equivalente aqui es implicito (una sola fila por caso, un solo intento de
 * espera legitimo a la vez).
 *
 * Nunca se llama si la decision ya existia antes de que la Task arrancara
 * -- ver requestHumanDecisionFn.ts, que resuelve ese caso llamando
 * SendTaskSuccess directamente con su propio token, sin tocar esta tabla.
 */
export async function prepareWaitForDecision(
  tableName: string,
  caseId: string,
  taskToken: string,
  ttlSeconds: number,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const ttlEpochSeconds = Math.floor(now.getTime() / 1000) + ttlSeconds;

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          caseId,
          callbackType: HUMAN_DECISION_CALLBACK_TYPE,
          taskToken,
          status: "PENDING",
          createdAt: nowIso,
          updatedAt: nowIso,
          ttlEpochSeconds,
        },
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
    return;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
  }

  // Ya existe (reintento de la misma Task): solo refrescar el token si
  // sigue PENDING. Si ya paso a RESOLVING/RESOLVED/UNCONFIRMED, alguien ya
  // esta resolviendo o ya resolvio -- no pisar nada.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: HUMAN_DECISION_CALLBACK_TYPE },
        UpdateExpression: "SET taskToken = :token, updatedAt = :now, ttlEpochSeconds = :ttl",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":token": taskToken, ":now": nowIso, ":ttl": ttlEpochSeconds, ":pending": "PENDING" },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // RESOLVING/RESOLVED/UNCONFIRMED: no-op seguro, este token nuevo queda
    // sin uso -- el timeout nativo del wait absorbe el caso si hiciera falta.
  }
}

/**
 * Reconciliacion incondicional antes de EscalationPolicy (mismo espiritu
 * que reconcileAfterWorkflowOutcome en services/evidence/src/
 * callbackStore.ts): marca la fila RESOLVED sin importar su status actual,
 * para que una decision humana TARDIA (que llega despues del timeout, pero
 * antes de que EscalationPolicy/EmergencyDialer terminen) nunca intente
 * resolver un taskToken ya muerto. La decision tardia sigue pudiendo
 * escribir AnomalyCases.humanDecision -- eso es independiente de esta
 * tabla y es lo que EscalationPolicy vuelve a verificar en caliente.
 */
export async function reconcileHumanDecisionCallback(tableName: string, caseId: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { caseId, callbackType: HUMAN_DECISION_CALLBACK_TYPE },
        UpdateExpression: "SET #status = :resolved, updatedAt = :now",
        ConditionExpression: "attribute_exists(caseId)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":resolved": "RESOLVED", ":now": new Date().toISOString() },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    // No existe fila (requestHumanDecisionFn resolvio de inmediato y nunca
    // la creo): nada que reconciliar.
  }
}
