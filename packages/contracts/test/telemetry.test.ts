import { describe, expect, it } from "vitest";
import { validateTelemetry } from "../src/index.js";
import type { Telemetry } from "../src/index.js";

const DEVICE_ID = "pi-demo-01";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

const baseValid: Telemetry = {
  eventId: EVENT_ID,
  deviceId: DEVICE_ID,
  occurredAt: "2026-09-23T18:30:00Z",
  firmwareVersion: "0.1.0",
  temperatureC: 27.3,
  humidityPct: 48.1,
  co2Ppm: 840,
  proximityCm: 120,
  motion: false,
};

describe("Telemetry schema", () => {
  it("accepts a valid telemetry payload", () => {
    expect(validateTelemetry(baseValid)).toBe(true);
    expect(validateTelemetry.errors).toBeNull();
  });

  it("accepts a minimal payload without optional sensor fields", () => {
    const minimal: Telemetry = {
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
      occurredAt: "2026-09-23T18:30:00Z",
      firmwareVersion: "0.1.0",
    };
    expect(validateTelemetry(minimal)).toBe(true);
  });

  it("rejects a payload missing eventId", () => {
    const { eventId: _eventId, ...rest } = baseValid;
    expect(validateTelemetry(rest)).toBe(false);
  });

  it("rejects occurredAt without a trailing Z", () => {
    expect(validateTelemetry({ ...baseValid, occurredAt: "2026-09-23T18:30:00" })).toBe(false);
  });

  it("rejects the legacy 'timestamp' field instead of occurredAt", () => {
    const { occurredAt: _occurredAt, ...rest } = baseValid;
    const legacyShape = { ...rest, timestamp: "2026-09-23T18:30:00Z" };
    expect(validateTelemetry(legacyShape)).toBe(false);
  });

  it("rejects a recipientId field coming from the edge", () => {
    expect(validateTelemetry({ ...baseValid, recipientId: "recipient-demo-01" })).toBe(false);
  });

  it("rejects an out-of-range humidity reading", () => {
    expect(validateTelemetry({ ...baseValid, humidityPct: 140 })).toBe(false);
  });

  it("rejects a calendar-invalid day (February 30th)", () => {
    expect(validateTelemetry({ ...baseValid, occurredAt: "2026-02-30T10:00:00Z" })).toBe(false);
  });

  it("rejects an out-of-range month", () => {
    expect(validateTelemetry({ ...baseValid, occurredAt: "2026-13-01T00:00:00Z" })).toBe(false);
  });

  it("accepts February 29th on a real leap year", () => {
    expect(validateTelemetry({ ...baseValid, occurredAt: "2024-02-29T00:00:00Z" })).toBe(true);
  });

  it("rejects February 29th on a non-leap year", () => {
    expect(validateTelemetry({ ...baseValid, occurredAt: "2025-02-29T00:00:00Z" })).toBe(false);
  });
});
