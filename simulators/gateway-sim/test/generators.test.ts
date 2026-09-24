import { describe, expect, it } from "vitest";
import { validateSensorAnomaly, validateTelemetry, validateVisualAnomaly } from "@sensecare/contracts";
import { generateTelemetry } from "../src/telemetryGenerator.js";
import { generatePoorAirQuality, generateTemperatureAlert } from "../src/sensorAnomalyGenerator.js";
import { generateVisualAnomalyFixture } from "../src/visualAnomalyFixture.js";

const DEVICE_ID = "pi-demo-01";

describe("gateway-sim generators", () => {
  it("generates telemetry that satisfies the shared Telemetry schema", () => {
    expect(validateTelemetry(generateTelemetry(DEVICE_ID))).toBe(true);
  });

  it("generates a TEMPERATURE_ALERT that satisfies the shared SensorAnomaly schema", () => {
    expect(validateSensorAnomaly(generateTemperatureAlert(DEVICE_ID))).toBe(true);
  });

  it("generates a POOR_AIR_QUALITY event that satisfies the shared SensorAnomaly schema", () => {
    expect(validateSensorAnomaly(generatePoorAirQuality(DEVICE_ID))).toBe(true);
  });

  it("generates a visual anomaly fixture that satisfies the shared VisualAnomaly schema", () => {
    expect(validateVisualAnomaly(generateVisualAnomalyFixture(DEVICE_ID))).toBe(true);
  });
});
