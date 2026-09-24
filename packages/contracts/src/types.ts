/**
 * Tipos TypeScript escritos a mano, en espejo de los JSON Schema en
 * ../schemas. Los JSON Schema son la fuente de verdad en tiempo de
 * ejecucion (y lo que reutilizara el edge en Python); estos tipos existen
 * para dar autocompletado/chequeo estatico en TypeScript. Cualquier cambio
 * de contrato debe actualizar el schema y este archivo juntos.
 */

export type Uuid = string;
export type DeviceId = string;
export type CaseId = string;
export type CommandId = string;

/** ISO-8601 UTC, siempre terminado en "Z" (sin offsets alternos). */
export type Iso8601Utc = string;

export interface Telemetry {
  eventId: Uuid;
  deviceId: DeviceId;
  occurredAt: Iso8601Utc;
  firmwareVersion: string;
  temperatureC?: number;
  humidityPct?: number;
  co2Ppm?: number;
  proximityCm?: number;
  dbAvg?: number;
  dbPeak?: number;
  sourceTimestampUnavailable?: boolean;
}

export type VisualAnomalyType =
  | "POSSIBLE_FALL"
  | "PERSON_PRONE_INACTIVE"
  | "UNEXPECTED_PERSON"
  | "POSSIBLE_SMOKE_OR_FIRE"
  | "CAMERA_TAMPERED";

export type RiskCandidate = VisualAnomalyType | "POSSIBLE_UNCONSCIOUSNESS";

export interface VisualAnomalyEvidence {
  personCount: number;
  zone: string;
  posture?: "standing" | "lying_or_fallen" | "unknown";
  horizontalSeconds?: number;
  motionAfterSeconds?: number;
}

export interface VisualAnomalyModelVersions {
  pose: string;
  person: string;
  smokeFire?: string;
}

export interface VisualAnomaly {
  eventId: Uuid;
  eventType: "VISUAL_ANOMALY";
  deviceId: DeviceId;
  occurredAt: Iso8601Utc;
  anomalyType: VisualAnomalyType;
  confidence: number;
  candidates: RiskCandidate[];
  evidence: VisualAnomalyEvidence;
  modelVersions: VisualAnomalyModelVersions;
  sensors?: {
    temperatureC?: number;
    co2Ppm?: number;
  };
}

export type SensorAnomalyType =
  | "POOR_AIR_QUALITY"
  | "TEMPERATURE_ALERT"
  | "SENSOR_FAULT"
  | "POSSIBLE_CO_EXPOSURE"
  | "POSSIBLE_GAS_LEAK"
  | "POSSIBLE_FIRE";

export interface SensorAnomaly {
  eventId: Uuid;
  eventType: "SENSOR_ANOMALY";
  deviceId: DeviceId;
  occurredAt: Iso8601Utc;
  anomalyType: SensorAnomalyType;
  severity: "warning" | "critical";
  sensorRule: {
    ruleVersion: string;
    windowSeconds: number;
    trigger: string;
  };
  sensors: {
    temperatureC?: number;
    humidityPct?: number;
    co2Ppm?: number;
    proximityCm?: number;
  };
}

export interface UploadEvidenceCommand {
  commandId: CommandId;
  caseId: CaseId;
  command: "UPLOAD_EVIDENCE";
  reason: "LOCAL_VISUAL_ANOMALY" | "SENSOR_ANOMALY";
  captureMode: "BUFFERED" | "CURRENT";
  s3Key: string;
  uploadUrl: string;
  expiresAt: Iso8601Utc;
}

export type CommandAckReason =
  | "EXPIRED"
  | "INVALID_S3_KEY"
  | "FRAME_NOT_AVAILABLE"
  | "INVALID_CASE"
  | "INTERNAL_ERROR";

export interface CommandAck {
  eventId: Uuid;
  commandId: CommandId;
  caseId: CaseId;
  command: "UPLOAD_EVIDENCE";
  occurredAt: Iso8601Utc;
  accepted: boolean;
  reason?: CommandAckReason;
}

export interface EvidenceUploaded {
  eventId: Uuid;
  commandId: CommandId;
  caseId: CaseId;
  eventType: "EVIDENCE_UPLOADED";
  occurredAt: Iso8601Utc;
  s3Key: string;
  imageId: Uuid;
}

export type EvidenceFailedErrorCode =
  | "UPLOAD_TIMEOUT"
  | "URL_EXPIRED"
  | "FRAME_NOT_AVAILABLE"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export interface EvidenceFailed {
  eventId: Uuid;
  commandId: CommandId;
  caseId: CaseId;
  eventType: "EVIDENCE_FAILED";
  occurredAt: Iso8601Utc;
  errorCode: EvidenceFailedErrorCode;
}

export type EvidenceResult = EvidenceUploaded | EvidenceFailed;

export type AnomalyDetectedEventType = "VISUAL_ANOMALY" | "SENSOR_ANOMALY";
export type AnomalyDetectedAnomalyType = VisualAnomalyType | SensorAnomalyType;

/**
 * Detalle publicado al bus EventBridge "SenseCare"
 * (source: "SenseCare", detail-type: "anomaly.detected") por
 * anomalyIngestCore (Hito 2). NO es un contrato de borde (MQTT/edge); es
 * un evento interno backend-a-backend entre @sensecare/ingestion
 * (productor) y @sensecare/orchestration (consumidor, Hito 4).
 * caseDispatcherFn valida este detalle contra el schema antes de
 * StartExecution.
 */
export interface AnomalyDetectedEventDetail {
  caseId: CaseId;
  deviceId: DeviceId;
  recipientId: string;
  eventId: Uuid;
  eventType: AnomalyDetectedEventType;
  anomalyType: AnomalyDetectedAnomalyType;
  occurredAt: Iso8601Utc;
}
