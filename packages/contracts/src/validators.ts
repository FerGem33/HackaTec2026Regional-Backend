import { createAjv } from "./ajv.js";
import {
  telemetrySchema,
  visualAnomalySchema,
  sensorAnomalySchema,
  uploadEvidenceCommandSchema,
  commandAckSchema,
  evidenceResultSchema,
} from "./schemas.js";
import type {
  Telemetry,
  VisualAnomaly,
  SensorAnomaly,
  UploadEvidenceCommand,
  CommandAck,
  EvidenceResult,
} from "./types.js";

const ajv = createAjv();

export const validateTelemetry = ajv.compile<Telemetry>(telemetrySchema);
export const validateVisualAnomaly = ajv.compile<VisualAnomaly>(visualAnomalySchema);
export const validateSensorAnomaly = ajv.compile<SensorAnomaly>(sensorAnomalySchema);
export const validateUploadEvidenceCommand = ajv.compile<UploadEvidenceCommand>(
  uploadEvidenceCommandSchema,
);
export const validateCommandAck = ajv.compile<CommandAck>(commandAckSchema);
export const validateEvidenceResult = ajv.compile<EvidenceResult>(evidenceResultSchema);
