function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de dispatchPushFn, separada de alertConfig.ts a
 * proposito (mismo motivo documentado en dispatcherConfig.ts): esta Lambda
 * necesita un conjunto de tablas distinto (CaregiverPushEndpoints,
 * AlertDeliveries) y NUNCA el topic SNS de email ni ALERTS_TABLE_NAME.
 */
export const pushConfig = {
  caregiverAccessTableName: requireEnv("CAREGIVER_ACCESS_TABLE_NAME"),
  caregiverPushEndpointsTableName: requireEnv("CAREGIVER_PUSH_ENDPOINTS_TABLE_NAME"),
  alertDeliveriesTableName: requireEnv("ALERT_DELIVERIES_TABLE_NAME"),
  pinpointApplicationId: requireEnv("PINPOINT_APPLICATION_ID"),
};
