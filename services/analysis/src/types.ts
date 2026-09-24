import type { AnomalyDetectedEventDetail } from "@sensecare/contracts";

/**
 * Forma comun del payload que cada Task de Step Functions recibe (mismo
 * patron que services/evidence/services/orchestration):
 * { "caseDetail.$": "$.caseDetail", "executionArn.$": "$.executionArn" }.
 */
export interface CaseTaskInput {
  caseDetail: AnomalyDetectedEventDetail;
  executionArn: string;
}

export interface AnalyzeEvidenceInput extends CaseTaskInput {
  evidenceS3Key: string;
  evidenceImageId: string;
}

/**
 * Unico vocabulario de riesgo que el modelo puede usar: los mismos
 * candidatos visuales que packages/contracts/schemas/visualAnomaly.schema.json
 * ya define (riskCandidate), nunca una categoria nueva inventada por el
 * modelo.
 */
export type EvidenceRiskIndicator =
  | "POSSIBLE_FALL"
  | "POSSIBLE_UNCONSCIOUSNESS"
  | "PERSON_PRONE_INACTIVE"
  | "UNEXPECTED_PERSON"
  | "POSSIBLE_SMOKE_OR_FIRE"
  | "CAMERA_TAMPERED";

export type EvidencePosture = "standing" | "lying_or_fallen" | "unknown";

export interface EvidenceObservation {
  personDetected: boolean;
  posture: EvidencePosture;
  riskIndicators: EvidenceRiskIndicator[];
  needsHumanReview: boolean;
  confidence: number;
  summary: string;
}

/**
 * Codigos cerrados de incertidumbre. Nunca se guarda texto crudo de
 * excepcion; ver services/analysis/src/analyzeEvidenceFn.ts para el mapeo
 * exacto de cada excepcion de Bedrock a uno de estos valores.
 */
export type AnalysisFailureReason =
  | "THROTTLED"
  | "MODEL_TIMEOUT"
  | "MODEL_UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "INTERNAL_ERROR";

export type AnalysisStatus = "COMPLETED" | "UNCERTAIN";

/**
 * Forma exacta que retorna analyzeEvidenceFn (y que reconstruyen los
 * estados Pass de la State Machine para las rutas de Catch): ambas claves
 * `observation`/`failureReason` siempre presentes (aunque sea null), para
 * que el Pass "PrepareAnalysisOutcome" nunca referencie una ruta ausente.
 */
export type AnalysisResult =
  | { analysisStatus: "COMPLETED"; observation: EvidenceObservation; failureReason: null }
  | { analysisStatus: "UNCERTAIN"; observation: null; failureReason: AnalysisFailureReason };

export type RecordAnalysisOutcomeInput = CaseTaskInput &
  AnalysisResult & {
    evidenceS3Key: string;
    evidenceImageId: string;
  };
