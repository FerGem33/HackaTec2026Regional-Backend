function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

function requirePositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`La variable de entorno ${name} debe ser un entero positivo; se recibio: "${raw}"`);
  }
  return parsed;
}

/**
 * Config exclusiva de requestHumanDecisionFn.ts, separada de
 * reconcileHumanDecisionConfig.ts a proposito (mismo motivo que
 * dispatcherConfig.ts vs taskConfig.ts): un modulo ES ejecuta TODO su
 * cuerpo top-level al importarse. reconcileHumanDecisionFn.ts en CDK solo
 * recibe CASE_ACTION_CALLBACKS_TABLE_NAME; si compartiera este archivo
 * (que tambien exige ANOMALY_CASES_TABLE_NAME), fallaria en cold start por
 * una variable que nunca necesita -- exactamente el incidente de
 * produccion ya corregido en services/ingestion/src/env.ts.
 */
export const config = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  caseActionCallbacksTableName: requireEnv("CASE_ACTION_CALLBACKS_TABLE_NAME"),
  // No es critico para la seguridad (el `status` del registro es lo que
  // importa, no el TTL): solo acota cuanto tiempo vive una fila efimera sin
  // reclamar. Independiente de humanDecisionWaitSeconds (el timeout real
  // del wait de Step Functions, configurado en case-orchestration.ts).
  callbackTtlSeconds: requirePositiveInt("HUMAN_DECISION_CALLBACK_TTL_SECONDS", 86400),
};
