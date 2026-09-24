import { config } from "./reconcileHumanDecisionConfig.js";
import { reconcileHumanDecisionCallback } from "./caseActionCallbackStore.js";

interface ReconcileHumanDecisionInput {
  caseDetail: { caseId: string };
  [key: string]: unknown;
}

/**
 * Task incondicional justo antes de EscalationPolicy (ESCALATED o TIMEOUT;
 * CANCELLED nunca llega aqui, ver la Choice en case-orchestration.ts).
 * Marca el callback de decision humana RESOLVED sin importar su estado
 * actual, para que un CANCEL_ALERT tardio (que llega despues del timeout,
 * pero antes de que EmergencyDialer complete) nunca intente resolver un
 * taskToken ya muerto. Esa decision tardia sigue pudiendo escribir
 * AnomalyCases.humanDecision de forma independiente -- EscalationPolicy la
 * vuelve a verificar en caliente antes de reclamar dialStatus=DIALING.
 *
 * `resultPath: DISCARD` en CDK: "$" nunca cambia por esta Task.
 */
export async function handler(input: ReconcileHumanDecisionInput): Promise<ReconcileHumanDecisionInput> {
  await reconcileHumanDecisionCallback(config.caseActionCallbacksTableName, input.caseDetail.caseId);
  return input;
}
