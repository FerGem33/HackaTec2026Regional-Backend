function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de recordCallOutcomeFn.ts: nunca Connect/SSM/KMS (esta
 * Lambda solo escribe DynamoDB/EventLog a partir del resultado que ya
 * produjo emergencyDialerFn.ts).
 */
export const config = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
};
