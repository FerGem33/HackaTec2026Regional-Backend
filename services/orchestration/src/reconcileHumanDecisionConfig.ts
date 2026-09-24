function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de reconcileHumanDecisionFn.ts. Ver
 * requestHumanDecisionConfig.ts para el porque de la separacion: esta
 * Lambda nunca lee AnomalyCases, asi que nunca debe exigir esa variable.
 */
export const config = {
  caseActionCallbacksTableName: requireEnv("CASE_ACTION_CALLBACKS_TABLE_NAME"),
};
