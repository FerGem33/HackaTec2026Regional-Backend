function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de escalationPolicyFn.ts. Deliberadamente SIN
 * `INSTANCE_ID`/`CONTACT_FLOW_ID`/`SOURCE_PHONE_NUMBER`/parametro SSM:
 * EscalationPolicy nunca necesita saber el destino real ni tocar Connect
 * (ver emergencyDialerConfig.ts, separado). Esta separacion de archivos
 * es intencional -- mismo motivo que dispatcherConfig.ts vs taskConfig.ts.
 */
export const config = {
  anomalyCasesTableName: requireEnv("ANOMALY_CASES_TABLE_NAME"),
  devicesTableName: requireEnv("DEVICES_TABLE_NAME"),
  eventLogTableName: requireEnv("EVENT_LOG_TABLE_NAME"),
  // Gate global explicito del operador (nunca true por defecto): un
  // sns:Publish exitoso prueba que SNS acepto el mensaje, NO que existe un
  // canal humano de notificacion activo (sin correos/push/WhatsApp
  // confirmados todavia, ver docs/ALERTS_AND_CASE_ACTIONS_RUNBOOK.md). Con
  // este flag ausente o "false", EscalationPolicy bloquea SIEMPRE el
  // camino automatico con NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL, sin
  // importar el resto de condiciones.
  humanNotificationChannelConfirmed: process.env.HUMAN_NOTIFICATION_CHANNEL_CONFIRMED === "true",
  // Allowlist propia de escalamiento (deviceId/recipientId de demo), nunca
  // el numero de telefono real: ese vive solo en el SSM SecureString que
  // lee emergencyDialerFn.ts.
  allowedDeviceIds: requireEnv("ESCALATION_ALLOWED_DEVICE_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
};
