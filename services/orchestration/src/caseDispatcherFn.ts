import type { EventBridgeEvent } from "aws-lambda";
import { ExecutionAlreadyExists, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { validateAnomalyDetectedEvent } from "@sensecare/contracts";
import { sfn } from "./clients.js";
import { config } from "./dispatcherConfig.js";

/**
 * Target de la regla EventBridge "AnomalyDetectedRule"
 * (source: "SenseCare", detail-type: "anomaly.detected"). No hay forma de
 * fijar un nombre de ejecucion determinista desde un target nativo de
 * EventBridge hacia Step Functions (SfnStateMachineProps de
 * aws-events-targets solo expone `input`/`role`), por eso esta Lambda
 * llama StartExecution directamente con name=caseId.
 *
 * Step Functions Standard deduplica StartExecution por nombre durante 90
 * dias: una segunda llamada con el mismo nombre y el mismo input es un
 * no-op idempotente; con input distinto lanza ExecutionAlreadyExists. En
 * ambos casos lo tratamos como exito, absorbiendo los duplicados que
 * produce la entrega "al menos una vez" de anomalyIngestCore (Hito 2).
 */
export async function handler(
  event: EventBridgeEvent<"anomaly.detected", unknown>,
): Promise<void> {
  const detail = event.detail;
  if (!validateAnomalyDetectedEvent(detail)) {
    throw new Error(
      `AnomalyDetectedEventDetail invalido: ${JSON.stringify(validateAnomalyDetectedEvent.errors)}`,
    );
  }

  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: config.stateMachineArn,
        name: detail.caseId,
        input: JSON.stringify(detail),
      }),
    );
  } catch (error) {
    if (error instanceof ExecutionAlreadyExists) {
      console.info("caseDispatcherFn: ejecucion ya existente para este caseId (duplicado absorbido)", {
        caseId: detail.caseId,
      });
      return;
    }
    throw error;
  }
}
