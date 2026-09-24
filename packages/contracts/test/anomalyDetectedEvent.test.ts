import { describe, expect, it } from "vitest";
import { validateAnomalyDetectedEvent } from "../src/index.js";
import type { AnomalyDetectedEventDetail } from "../src/index.js";

const baseValid: AnomalyDetectedEventDetail = {
  caseId: "44444444-4444-4444-b444-444444444444",
  deviceId: "pi-demo-01",
  recipientId: "recipient-demo-01",
  eventId: "22222222-2222-4222-9222-222222222222",
  eventType: "VISUAL_ANOMALY",
  anomalyType: "PERSON_PRONE_INACTIVE",
  occurredAt: "2026-09-23T18:30:00Z",
};

describe("AnomalyDetectedEventDetail schema", () => {
  it("accepts a valid VISUAL_ANOMALY detail", () => {
    expect(validateAnomalyDetectedEvent(baseValid)).toBe(true);
  });

  it("accepts a valid SENSOR_ANOMALY detail", () => {
    expect(
      validateAnomalyDetectedEvent({
        ...baseValid,
        eventType: "SENSOR_ANOMALY",
        anomalyType: "TEMPERATURE_ALERT",
      }),
    ).toBe(true);
  });

  it("rejects an eventType/anomalyType combination outside the closed enums", () => {
    expect(validateAnomalyDetectedEvent({ ...baseValid, eventType: "OTHER" })).toBe(false);
    expect(validateAnomalyDetectedEvent({ ...baseValid, anomalyType: "ON_FIRE" })).toBe(false);
  });

  it("rejects a payload missing caseId", () => {
    const { caseId: _caseId, ...rest } = baseValid;
    expect(validateAnomalyDetectedEvent(rest)).toBe(false);
  });

  it("rejects a payload missing recipientId", () => {
    const { recipientId: _recipientId, ...rest } = baseValid;
    expect(validateAnomalyDetectedEvent(rest)).toBe(false);
  });

  it("rejects a calendar-invalid occurredAt", () => {
    expect(validateAnomalyDetectedEvent({ ...baseValid, occurredAt: "2026-02-30T10:00:00Z" })).toBe(
      false,
    );
  });

  it("rejects an unexpected extra field", () => {
    expect(validateAnomalyDetectedEvent({ ...baseValid, executionArn: "arn:aws:states:..." })).toBe(
      false,
    );
  });

  it("accepts a SENSOR_ANOMALY detail with a critical severity", () => {
    expect(
      validateAnomalyDetectedEvent({
        ...baseValid,
        eventType: "SENSOR_ANOMALY",
        anomalyType: "TEMPERATURE_ALERT",
        severity: "critical",
      }),
    ).toBe(true);
  });

  it("accepts a VISUAL_ANOMALY detail without severity (optional field)", () => {
    expect(validateAnomalyDetectedEvent(baseValid)).toBe(true);
  });

  it("rejects a severity value outside the closed enum", () => {
    expect(
      validateAnomalyDetectedEvent({
        ...baseValid,
        eventType: "SENSOR_ANOMALY",
        anomalyType: "TEMPERATURE_ALERT",
        severity: "extreme",
      }),
    ).toBe(false);
  });
});
