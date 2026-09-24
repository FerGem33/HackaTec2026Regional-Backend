import type { AnomalyDetectedEventDetail } from "@sensecare/contracts";

/**
 * Forma del Payload que cada Task de Step Functions recibe. Se construye
 * en CDK como { "caseDetail.$": "$", "executionArn.$": "$$.Execution.Id" }
 * para cada LambdaInvoke; el estado ($) en si mismo nunca se muta entre
 * tasks (cada una descarta su resultado via resultPath: DISCARD).
 */
export interface CaseTaskInput {
  caseDetail: AnomalyDetectedEventDetail;
  executionArn: string;
}
