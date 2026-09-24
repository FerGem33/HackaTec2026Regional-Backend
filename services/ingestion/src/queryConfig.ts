import { requireEnv } from "./config.js";

/**
 * Config propia de los handlers de consulta (getDeviceLatestHandler,
 * getDeviceTelemetryHandler). Separada de config.ts porque esos Lambdas
 * disparados por SQS exigen variables (EVENT_LOG_TABLE_NAME, EVENT_BUS_NAME,
 * etc.) que un handler HTTP de solo lectura no usa ni debe necesitar para
 * arrancar.
 */
export const queryConfig = {
  devicesTableName: requireEnv("DEVICES_TABLE_NAME"),
  telemetryTableName: requireEnv("TELEMETRY_TABLE_NAME"),
  caregiverAccessTableName: requireEnv("CAREGIVER_ACCESS_TABLE_NAME"),
};
