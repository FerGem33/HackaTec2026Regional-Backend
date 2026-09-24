import Ajv2020 from "ajv/dist/2020.js";
import type { EvidenceObservation } from "./types.js";

/**
 * Schema runtime para la observacion que Bedrock debe devolver. Vive aqui
 * (local a services/analysis), no en packages/contracts: a diferencia de
 * los contratos MQTT, esto nunca cruza hacia el edge/Pi ni el simulador
 * Python; es puramente interno backend<->Bedrock. Solo enums ya definidos
 * por SenseCare (ver visualAnomaly.schema.json), nunca categorias nuevas.
 */
export const evidenceObservationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    personDetected: { type: "boolean" },
    posture: { type: "string", enum: ["standing", "lying_or_fallen", "unknown"] },
    riskIndicators: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "POSSIBLE_FALL",
          "POSSIBLE_UNCONSCIOUSNESS",
          "PERSON_PRONE_INACTIVE",
          "UNEXPECTED_PERSON",
          "POSSIBLE_SMOKE_OR_FIRE",
          "CAMERA_TAMPERED",
        ],
      },
      uniqueItems: true,
      maxItems: 6,
    },
    needsHumanReview: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string", minLength: 1, maxLength: 280 },
  },
  required: ["personDetected", "posture", "riskIndicators", "needsHumanReview", "confidence", "summary"],
  additionalProperties: false,
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validator = ajv.compile<EvidenceObservation>(evidenceObservationSchema);

/**
 * true/false, nunca lanza: una salida invalida de Bedrock es un resultado
 * de negocio esperado (analysisStatus=UNCERTAIN, failureReason=INVALID_OUTPUT),
 * no una excepcion.
 */
export function isValidEvidenceObservation(value: unknown): value is EvidenceObservation {
  return validator(value) === true;
}
