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
 * Se valida en cold start: si falta una variable de entorno requerida, o si
 * una numerica no es un entero positivo, la Lambda debe fallar de
 * inmediato en vez de comportarse de forma indefinida (p. ej. TTLs NaN o
 * negativos).
 */
export const config = {
  devicesTableName: requireEnv("DEVICES_TABLE_NAME"),
  telemetryTableName: requireEnv("TELEMETRY_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  openCaseLocksTableName: requireEnv("OPEN_CASE_LOCKS_TABLE_NAME"),
  eventBusName: requireEnv("EVENT_BUS_NAME"),
  // Hito 4 debe renovar este TTL mientras el caso siga abierto y
  // liberarlo/dejarlo expirar al cerrarlo; este valor es sólo el punto de
  // partida para cuando aún no existe ningún consumidor que lo gestione.
  openCaseLockTtlSeconds: requirePositiveInt("OPEN_CASE_LOCK_TTL_SECONDS", 7200),
  publishLeaseSeconds: requirePositiveInt("PUBLISH_LEASE_SECONDS", 10),
  telemetryRetentionDays: requirePositiveInt("TELEMETRY_RETENTION_DAYS", 60),
};
