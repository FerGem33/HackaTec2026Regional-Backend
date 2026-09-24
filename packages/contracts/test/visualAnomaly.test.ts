import { describe, expect, it } from "vitest";
import { validateVisualAnomaly } from "../src/index.js";
import type { VisualAnomaly } from "../src/index.js";

const EVENT_ID = "22222222-2222-4222-9222-222222222222";

const baseValid: VisualAnomaly = {
  eventId: EVENT_ID,
  eventType: "VISUAL_ANOMALY",
  deviceId: "pi-demo-01",
  occurredAt: "2026-09-23T18:30:00Z",
  anomalyType: "PERSON_PRONE_INACTIVE",
  confidence: 0.87,
  candidates: ["POSSIBLE_FALL", "POSSIBLE_UNCONSCIOUSNESS"],
  evidence: {
    personCount: 1,
    zone: "living_room",
    horizontalSeconds: 14,
    motionAfterSeconds: 12,
  },
  modelVersions: { pose: "pose-v1", person: "person-v1" },
};

describe("VisualAnomaly schema", () => {
  it("accepts a valid PERSON_PRONE_INACTIVE candidate payload", () => {
    expect(validateVisualAnomaly(baseValid)).toBe(true);
  });

  it("rejects an anomalyType outside the approved POSSIBLE_* set", () => {
    expect(validateVisualAnomaly({ ...baseValid, anomalyType: "CONFIRMED_INTRUDER" })).toBe(false);
  });

  it("rejects a payload asserting a diagnosis-like candidate", () => {
    expect(validateVisualAnomaly({ ...baseValid, candidates: ["HEART_ATTACK"] })).toBe(false);
  });

  it("rejects a payload that embeds a frame/image field", () => {
    expect(validateVisualAnomaly({ ...baseValid, frame: "base64..." })).toBe(false);
  });

  it("rejects a recipientId field coming from the edge", () => {
    expect(validateVisualAnomaly({ ...baseValid, recipientId: "recipient-demo-01" })).toBe(false);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(validateVisualAnomaly({ ...baseValid, confidence: 1.5 })).toBe(false);
  });

  it("rejects evidence missing zone", () => {
    const { zone: _zone, ...evidenceRest } = baseValid.evidence;
    expect(validateVisualAnomaly({ ...baseValid, evidence: evidenceRest })).toBe(false);
  });

  it("rejects a calendar-invalid occurredAt", () => {
    expect(validateVisualAnomaly({ ...baseValid, occurredAt: "2026-02-30T10:00:00Z" })).toBe(false);
  });
});
