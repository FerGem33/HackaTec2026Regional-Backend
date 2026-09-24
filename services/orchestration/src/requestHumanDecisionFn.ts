import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { ddb, sfn } from "./clients.js";
import { config } from "./requestHumanDecisionConfig.js";
import { prepareWaitForDecision } from "./caseActionCallbackStore.js";
import type { CaseTaskInput } from "./types.js";

interface RequestHumanDecisionInput extends CaseTaskInput {
  taskToken: string;
}

/**
 * Task de Step Functions con `integrationPattern: WAIT_FOR_TASK_TOKEN` (ver
 * case-orchestration.ts). Resuelve la carrera explicita "CANCEL_ALERT llega
 * ANTES de que la maquina entre al wait": un familiar puede cancelar justo
 * despues de recibir la alerta SNS, mientras el tramo de evidencia/analisis
 * todavia corre. Esta Task es la PRIMERA en enterarse de que existe un
 * `taskToken` para este caso, asi que solo ella puede detectar esa carrera
 * sin necesitar ninguna tabla: si `AnomalyCases.humanDecision` ya esta
 * escrito, resuelve su PROPIO token de inmediato con `SendTaskSuccess` y
 * jamas crea una fila en CaseActionCallbacks -- no hay nada que esperar.
 *
 * Si todavia no hay decision, persiste el token (ver
 * caseActionCallbackStore.ts) y retorna sin resolver: Step Functions
 * espera de verdad hasta que `services/cases/src/alertDecision.ts` (via
 * POST /cases/{caseId}/cancel|escalate) lo resuelva, o hasta el
 * `taskTimeout` nativo del wait.
 */
export async function handler(input: RequestHumanDecisionInput): Promise<void> {
  const { caseDetail, taskToken } = input;

  const existing = await ddb.send(
    new GetCommand({
      TableName: config.anomalyCasesTableName,
      Key: { caseId: caseDetail.caseId },
      ProjectionExpression: "humanDecision, cancelledBy, escalatedBy",
      ConsistentRead: true,
    }),
  );

  const humanDecision = existing.Item?.humanDecision as string | undefined;
  if (humanDecision === "CANCELLED" || humanDecision === "ESCALATED") {
    const resolvedBy =
      humanDecision === "CANCELLED"
        ? (existing.Item?.cancelledBy as string | undefined)
        : (existing.Item?.escalatedBy as string | undefined);

    await sfn.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ decision: humanDecision, resolvedBy: resolvedBy ?? "unknown" }),
      }),
    );
    return;
  }

  await prepareWaitForDecision(config.caseActionCallbacksTableName, caseDetail.caseId, taskToken, config.callbackTtlSeconds);
}
