function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de listCasesHandler, en un archivo separado de
 * casesConfig.ts a proposito (mismo motivo que dispatcherConfig.ts en
 * services/orchestration): este handler no necesita ALERTS_TABLE_NAME ni
 * EVENT_LOG_TABLE_NAME, así que no debe fallar en cold start por variables
 * que nunca usa.
 */
export const listCasesConfig = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  caregiverAccessTableName: requireEnv("CAREGIVER_ACCESS_TABLE_NAME"),
};
