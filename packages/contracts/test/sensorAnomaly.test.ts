import { describe, expect, it } from "vitest";
import { validateSensorAnomaly } from "../src/index.js";
import type { SensorAnomaly } from "../src/index.js";

const EVENT_ID = "33333333-3333-4333-a333-333333333333";

const baseValid: SensorAnomaly = {
  eventId: EVENT_ID,
  eventType: "SENSOR_ANOMALY",
  deviceId: "pi-demo-01",
  occurredAt: "2026-09-23T18:30:00Z",
  anomalyType: "TEMPERATURE_ALERT",
  severity: "warning",
  sensorRule: { ruleVersion: "sensor-rules-v1", windowSeconds: 60, trigger: "temperature_rise" },
  sensors: { temperatureC: 44.2, co2Ppm: 720 },
};

describe("SensorAnomaly schema", () => {
  it("accepts a valid sustained temperature alert", () => {
    expect(validateSensorAnomaly(baseValid)).toBe(true);
  });

  it("rejects severity values outside warning/critical", () => {
    expect(validateSensorAnomaly({ ...baseValid, severity: "info" })).toBe(false);
  });

  it("rejects a sensorRule without a time window", () => {
    const { windowSeconds: _windowSeconds, ...ruleRest } = baseValid.sensorRule;
    expect(validateSensorAnomaly({ ...baseValid, sensorRule: ruleRest })).toBe(false);
  });

  it("rejects an empty sensors object (no reading behind the alert)", () => {
    expect(validateSensorAnomaly({ ...baseValid, sensors: {} })).toBe(false);
  });

  it("rejects photo/audio evidence embedded in the payload", () => {
    expect(validateSensorAnomaly({ ...baseValid, audioClip: "base64..." })).toBe(false);
  });

  it("rejects a recipientId field coming from the edge", () => {
    expect(validateSensorAnomaly({ ...baseValid, recipientId: "recipient-demo-01" })).toBe(false);
  });

  it("rejects a calendar-invalid occurredAt", () => {
    expect(validateSensorAnomaly({ ...baseValid, occurredAt: "2026-02-30T10:00:00Z" })).toBe(false);
  });
});
