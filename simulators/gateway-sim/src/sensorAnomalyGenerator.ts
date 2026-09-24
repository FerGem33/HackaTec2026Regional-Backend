import { randomUUID } from "node:crypto";
import type { SensorAnomaly } from "@sensecare/contracts";

export function generateTemperatureAlert(deviceId: string): SensorAnomaly {
  return {
    eventId: randomUUID(),
    eventType: "SENSOR_ANOMALY",
    deviceId,
    occurredAt: new Date().toISOString(),
    anomalyType: "TEMPERATURE_ALERT",
    severity: "warning",
    sensorRule: {
      ruleVersion: "sensor-rules-sim-v1",
      windowSeconds: 60,
      trigger: "temperature_rise",
    },
    sensors: { temperatureC: 44.2, co2Ppm: 720 },
  };
}

export function generatePoorAirQuality(deviceId: string): SensorAnomaly {
  return {
    eventId: randomUUID(),
    eventType: "SENSOR_ANOMALY",
    deviceId,
    occurredAt: new Date().toISOString(),
    anomalyType: "POOR_AIR_QUALITY",
    severity: "warning",
    sensorRule: {
      ruleVersion: "sensor-rules-sim-v1",
      windowSeconds: 900,
      trigger: "co2_sustained_high",
    },
    sensors: { co2Ppm: 1650 },
  };
}
