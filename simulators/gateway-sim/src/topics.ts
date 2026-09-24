export function topicsFor(deviceId: string) {
  return {
    telemetry: `SenseCare/v1/devices/${deviceId}/telemetry`,
    visualAnomaly: `SenseCare/v1/devices/${deviceId}/visual/anomaly`,
    sensorAnomaly: `SenseCare/v1/devices/${deviceId}/sensor/anomaly`,
  } as const;
}
