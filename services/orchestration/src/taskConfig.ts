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
    throw new Error(
      `La variable de entorno ${name} debe ser un entero positivo; se recibio: "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Config compartida por las dos Task Lambdas de Step Functions
 * (renewOpenCaseLockFn, upsertAnomalyCaseFn): en CDK ambas reciben el
 * mismo conjunto de variables de entorno, asi que validarlas juntas aqui
 * es consistente. caseDispatcherFn usa dispatcherConfig.ts en su lugar
 * (ver el comentario ahi para el porque de la separacion).
 *
 * Hito 4 solo renueva el lock una vez al iniciar la ejecucion. La
 * renovacion periodica mientras el caso sigue abierto, y la
 * liberacion/expiracion explicita al cerrarlo, quedan documentadas para
 * el hito que agregue estados de espera (CheckCameraConsent en
 * adelante); no se implementan aqui.
 */
export const config = {
  openCaseLocksTableName: requireEnv("OPEN_CASE_LOCKS_TABLE_NAME"),
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  openCaseLockTtlSeconds: requirePositiveInt("OPEN_CASE_LOCK_TTL_SECONDS", 7200),
};
