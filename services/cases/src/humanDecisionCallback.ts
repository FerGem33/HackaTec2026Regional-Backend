import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { InvalidToken, SendTaskSuccessCommand, TaskDoesNotExist, TaskTimedOut } from "@aws-sdk/client-sfn";
import { ddb, sfn } from "./clients.js";
import { casesConfig } from "./casesConfig.js";
import type { AlertDecision } from "./alertDecision.js";

export const HUMAN_DECISION_CALLBACK_TYPE = "HUMAN_DECISION" as const;

export interface PendingHumanDecisionCallback {
  caseId: string;
  callbackType: typeof HUMAN_DECISION_CALLBACK_TYPE;
  taskToken: string;
  status: "PENDING" | "RESOLVING" | "UNCONFIRMED" | "RESOLVED";
}

/**
 * Lee (sin reclamar) el callback de decision humana pendiente, si existe.
 * Solo relevante cuando `status === "PENDING"`: la maquina de estados ya
 * llego a `RequestHumanDecision` (services/orchestration/src/
 * requestHumanDecisionFn.ts) y esta esperando de verdad. Si la fila no
 * existe -- la anomalia todavia no llega a esa fase, o
 * `requestHumanDecisionFn` ya resolvio de inmediato porque la decision
 * llego antes del wait -- no hay nada que reclamar aqui: `applyAlertDecision`
 * solo actualiza AnomalyCases/Alerts.
 */
export async function getPendingHumanDecisionCallback(
  caseId: string,
): Promise<PendingHumanDecisionCallback | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: casesConfig.caseActionCallbacksTableName,
      Key: { caseId, callbackType: HUMAN_DECISION_CALLBACK_TYPE },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as PendingHumanDecisionCallback | undefined;
  return item?.status === "PENDING" ? item : undefined;
}

/**
 * Fase 2 (fuera de la transaccion DynamoDB): resuelve el taskToken que la
 * transaccion en `alertDecision.ts` ya dejo en `RESOLVING` de forma
 * atomica. `SendTaskSuccess` es la unica llamada usada -- tanto CANCELLED
 * como ESCALATED son resoluciones EXITOSAS del wait, nunca
 * `SendTaskFailure` (eso confundiria la decision humana con un error
 * tecnico en el Catch de la Task).
 *
 * `InvalidToken`/`TaskDoesNotExist`/`TaskTimedOut` NO se tratan como fallo
 * grave: la decision del humano ya quedo aplicada de forma duradera en
 * AnomalyCases/Alerts (la transaccion previa ya tuvo exito); esto solo
 * significa que Step Functions ya no puede enterarse por esta via (p. ej.
 * el timeout nativo ya disparo). Se marca `UNCONFIRMED` y no se relanza.
 */
export async function resolveHumanDecisionCallback(
  caseId: string,
  taskToken: string,
  decision: AlertDecision,
  userId: string,
): Promise<void> {
  try {
    await sfn.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ decision, resolvedBy: userId }),
      }),
    );
    await ddb.send(
      new UpdateCommand({
        TableName: casesConfig.caseActionCallbacksTableName,
        Key: { caseId, callbackType: HUMAN_DECISION_CALLBACK_TYPE },
        UpdateExpression: "SET #status = :resolved, updatedAt = :now",
        ConditionExpression: "#status = :resolving",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolved": "RESOLVED",
          ":resolving": "RESOLVING",
          ":now": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (error instanceof InvalidToken || error instanceof TaskDoesNotExist || error instanceof TaskTimedOut) {
      await ddb.send(
        new UpdateCommand({
          TableName: casesConfig.caseActionCallbacksTableName,
          Key: { caseId, callbackType: HUMAN_DECISION_CALLBACK_TYPE },
          UpdateExpression: "SET #status = :unconfirmed, updatedAt = :now",
          ConditionExpression: "#status = :resolving",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":unconfirmed": "UNCONFIRMED",
            ":resolving": "RESOLVING",
            ":now": new Date().toISOString(),
          },
        }),
      );
      return;
    }
    console.error(
      JSON.stringify({
        event: "human_decision_callback_resolution_failed",
        caseId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    // Nunca relanzar: la decision ya se aplico de forma duradera en
    // AnomalyCases/Alerts; un fallo aqui solo retrasa que Step Functions se
    // entere (EscalationPolicy vuelve a verificar humanDecision de todos
    // modos, y el timeout nativo del wait lo resuelve si nadie mas lo hace).
  }
}
