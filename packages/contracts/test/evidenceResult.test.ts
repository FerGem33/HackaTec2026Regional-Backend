import { describe, expect, it } from "vitest";
import { validateEvidenceResult } from "../src/index.js";
import type { EvidenceResult } from "../src/index.js";

const EVENT_ID = "88888888-8888-4888-b888-888888888888";
const COMMAND_ID = "44444444-4444-4444-b444-444444444444";
const CASE_ID = "55555555-5555-4555-8555-555555555555";
const IMAGE_ID = "66666666-6666-4666-9666-666666666666";

const uploaded: EvidenceResult = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  eventType: "EVIDENCE_UPLOADED",
  occurredAt: "2026-09-23T18:30:10Z",
  s3Key: `raw-images/recipient-demo-01/${CASE_ID}/${IMAGE_ID}.jpg`,
  imageId: IMAGE_ID,
};

const failed: EvidenceResult = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  eventType: "EVIDENCE_FAILED",
  occurredAt: "2026-09-23T18:30:10Z",
  errorCode: "UPLOAD_TIMEOUT",
};

describe("EvidenceResult schema (EVIDENCE_UPLOADED / EVIDENCE_FAILED)", () => {
  it("accepts a successful upload confirmation", () => {
    expect(validateEvidenceResult(uploaded)).toBe(true);
  });

  it("accepts a failure notification with a safe error code", () => {
    expect(validateEvidenceResult(failed)).toBe(true);
  });

  it("rejects a mixed payload declaring EVIDENCE_UPLOADED with an errorCode", () => {
    expect(
      validateEvidenceResult({ ...uploaded, errorCode: "IO_ERROR" } as unknown as EvidenceResult),
    ).toBe(false);
  });

  it("rejects an EVIDENCE_FAILED payload with a free-text error message", () => {
    expect(
      validateEvidenceResult({
        ...failed,
        errorCode: "network timeout while uploading",
      } as unknown as EvidenceResult),
    ).toBe(false);
  });

  it("rejects a payload missing commandId", () => {
    const { commandId: _commandId, ...rest } = uploaded;
    expect(validateEvidenceResult(rest)).toBe(false);
  });

  it("rejects a payload missing eventId", () => {
    const { eventId: _eventId, ...rest } = uploaded;
    expect(validateEvidenceResult(rest)).toBe(false);
  });

  it("rejects a payload with a malformed eventId", () => {
    expect(
      validateEvidenceResult({ ...uploaded, eventId: "not-a-uuid" } as unknown as EvidenceResult),
    ).toBe(false);
  });

  it("rejects a calendar-invalid occurredAt", () => {
    expect(
      validateEvidenceResult({
        ...uploaded,
        occurredAt: "2026-02-30T10:00:00Z",
      } as unknown as EvidenceResult),
    ).toBe(false);
  });
});
