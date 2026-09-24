function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

export const unregisterPushDeviceConfig = {
  caregiverPushEndpointsTableName: requireEnv("CAREGIVER_PUSH_ENDPOINTS_TABLE_NAME"),
  pinpointApplicationId: requireEnv("PINPOINT_APPLICATION_ID"),
};
