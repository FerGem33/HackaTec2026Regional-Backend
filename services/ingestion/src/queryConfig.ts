import { requireEnv } from "./env.js";

/**
 * Config propia de los handlers de consulta (getDeviceLatestHandler,
 * getDeviceTelemetryHandler, pairDeviceHandler). Separada del `config` de
 * config.ts (compartido por los 3 Lambdas disparados por SQS) porque esos
 * exigen variables (EVENT_LOG_TABLE_NAME, EVENT_BUS_NAME, etc.) que un
 * handler HTTP de solo lectura no usa ni debe necesitar para arrancar.
 * Importa `requireEnv` de env.ts (helper puro, sin efectos secundarios),
 * nunca de config.ts: importarlo de ahi arrastraria el objeto `config`
 * eager de ese archivo y exigiria esas mismas variables SQS en cold start
 * (incidente de produccion ya corregido, ver env.ts).
 */
export const queryConfig = {
  devicesTableName: requireEnv("DEVICES_TABLE_NAME"),
  telemetryTableName: requireEnv("TELEMETRY_TABLE_NAME"),
  caregiverAccessTableName: requireEnv("CAREGIVER_ACCESS_TABLE_NAME"),
};
