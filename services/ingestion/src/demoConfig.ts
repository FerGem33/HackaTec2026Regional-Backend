import { requireEnv } from "./config.js";

/**
 * Config propia de demoIngestHandler, separada de config.ts (compartido por
 * los 3 Lambdas disparados por SQS) porque este handler es HTTP y necesita
 * cosas que los otros no: a donde escribir en SQS y la allowlist de
 * deviceId de demo. No reutiliza config.ts.config para no mezclar el
 * contrato de ambos handlers.
 */
export const demoConfig = {
  telemetryQueueUrl: requireEnv("DEMO_TELEMETRY_QUEUE_URL"),
  sensorAnomalyQueueUrl: requireEnv("DEMO_SENSOR_ANOMALY_QUEUE_URL"),
  // CSV en una sola variable de entorno: deviceId reservados para el
  // simulador web, SIN superposicion con deviceId de dispositivos fisicos
  // reales (esos tienen certificado X.509, nunca deben poder autenticarse
  // por este camino HTTPS).
  deviceAllowlist: new Set(
    requireEnv("DEMO_DEVICE_ALLOWLIST")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ),
};
