import { describe, expect, it } from "vitest";
import { validateUploadEvidenceCommand } from "../src/index.js";
import type { UploadEvidenceCommand } from "../src/index.js";

const COMMAND_ID = "44444444-4444-4444-b444-444444444444";
const CASE_ID = "55555555-5555-4555-8555-555555555555";

const baseValid: UploadEvidenceCommand = {
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  command: "UPLOAD_EVIDENCE",
  reason: "LOCAL_VISUAL_ANOMALY",
  captureMode: "BUFFERED",
  s3Key: `raw-images/recipient-demo-01/${CASE_ID}/66666666-6666-4666-9666-666666666666.jpg`,
  uploadUrl: "https://example-bucket.s3.amazonaws.com/upload?sig=abc",
  expiresAt: "2026-09-23T18:35:00Z",
};

describe("UploadEvidenceCommand schema", () => {
  it("accepts a valid BUFFERED capture command", () => {
    expect(validateUploadEvidenceCommand(baseValid)).toBe(true);
  });

  it("accepts a valid CURRENT capture command for a sensor case", () => {
    expect(
      validateUploadEvidenceCommand({ ...baseValid, reason: "SENSOR_ANOMALY", captureMode: "CURRENT" }),
    ).toBe(true);
  });

  it("rejects a Step Functions task token field", () => {
    expect(validateUploadEvidenceCommand({ ...baseValid, taskToken: "AAAA..." })).toBe(false);
  });

  it("rejects an s3Key outside the raw-images/{recipientId}/{caseId}/ prefix", () => {
    expect(validateUploadEvidenceCommand({ ...baseValid, s3Key: "other-prefix/image.jpg" })).toBe(
      false,
    );
  });

  it("rejects a non-https uploadUrl", () => {
    expect(
      validateUploadEvidenceCommand({ ...baseValid, uploadUrl: "http://example.com/upload" }),
    ).toBe(false);
  });

  it("rejects an unknown captureMode", () => {
    expect(validateUploadEvidenceCommand({ ...baseValid, captureMode: "CONTINUOUS" })).toBe(false);
  });

  it("rejects a calendar-invalid expiresAt", () => {
    expect(validateUploadEvidenceCommand({ ...baseValid, expiresAt: "2026-02-30T10:00:00Z" })).toBe(
      false,
    );
  });
});
