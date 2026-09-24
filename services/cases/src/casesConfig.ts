function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config compartida por los 3 handlers HTTP de este paquete
 * (getCaseEventsHandler, cancelCaseHandler, escalateCaseHandler): las tres
 * reciben en CDK exactamente este mismo conjunto de variables. Duplicado a
 * proposito en vez de importar de otro paquete de servicio: cada
 * services/* es una unidad de despliegue independiente (mismo patron que
 * services/ingestion, services/evidence, services/orchestration).
 */
export const casesConfig = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  alertsTableName: requireEnv("ALERTS_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  caregiverAccessTableName: requireEnv("CAREGIVER_ACCESS_TABLE_NAME"),
  caseActionCallbacksTableName: requireEnv("CASE_ACTION_CALLBACKS_TABLE_NAME"),
};
