function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de dispatchAlertFn, separada de taskConfig.ts por el
 * mismo motivo que dispatcherConfig.ts (ver ese archivo): un modulo ES
 * ejecuta todo su cuerpo top-level al importarse, y esta Lambda recibe en
 * CDK un conjunto de variables distinto (Alerts, CaregiverAccess con su
 * GSI, AnomalyCases para el espejo de alertStatus, y el topic SNS) al de
 * renewOpenCaseLockFn/upsertAnomalyCaseFn.
 */
export const config = {
  alertsTableName: requireEnv("ALERTS_TABLE_NAME"),
  caregiverAccessTableName: requireEnv("CAREGIVER_ACCESS_TABLE_NAME"),
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  alertsTopicArn: requireEnv("ALERTS_TOPIC_ARN"),
};
