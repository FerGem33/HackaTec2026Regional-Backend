import type { AnomalyDetectedEventDetail } from "@sensecare/contracts";

/**
 * Forma comun del Payload que cada Task de Step Functions recibe:
 * { "caseDetail.$": "$", "executionArn.$": "$$.Execution.Id" } (mismo
 * patron que services/orchestration).
 */
export interface CaseTaskInput {
  caseDetail: AnomalyDetectedEventDetail;
  executionArn: string;
}
