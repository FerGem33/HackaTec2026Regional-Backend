function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de registerPushDeviceHandler, separada de
 * unregisterPushDeviceConfig.ts a proposito (mismo motivo que
 * dispatcherConfig.ts en services/orchestration): unregister nunca
 * necesita PINPOINT_APPLICATION_ID para crear nada nuevo (solo borra un
 * endpoint ya existente por su id determinista), asi que no debe fallar en
 * cold start por una variable que no usa igual -- aunque en este caso
 * ambas SI la necesitan para llamar a Pinpoint, se mantiene la separacion
 * por consistencia con el resto del repo y porque register ademas escribe
 * PLATFORM (unregister no).
 */
export const registerPushDeviceConfig = {
  caregiverPushEndpointsTableName: requireEnv("CAREGIVER_PUSH_ENDPOINTS_TABLE_NAME"),
  pinpointApplicationId: requireEnv("PINPOINT_APPLICATION_ID"),
};
