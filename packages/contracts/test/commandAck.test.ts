import { describe, expect, it } from "vitest";
import { validateCommandAck } from "../src/index.js";
import type { CommandAck } from "../src/index.js";

const EVENT_ID = "77777777-7777-4777-a777-777777777777";
const COMMAND_ID = "44444444-4444-4444-b444-444444444444";
const CASE_ID = "55555555-5555-4555-8555-555555555555";

const acceptedAck: CommandAck = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  command: "UPLOAD_EVIDENCE",
  occurredAt: "2026-09-23T18:30:05Z",
  accepted: true,
};

describe("CommandAck schema", () => {
  it("accepts an accepted ack without a reason", () => {
    expect(validateCommandAck(acceptedAck)).toBe(true);
  });

  it("accepts a rejected ack that includes a safe reason code", () => {
    expect(validateCommandAck({ ...acceptedAck, accepted: false, reason: "EXPIRED" })).toBe(true);
  });

  it("accepts COMMAND_CONFLICT as a valid rejection reason", () => {
    expect(validateCommandAck({ ...acceptedAck, accepted: false, reason: "COMMAND_CONFLICT" })).toBe(
      true,
    );
  });

  it("rejects a rejected ack without a reason", () => {
    expect(validateCommandAck({ ...acceptedAck, accepted: false })).toBe(false);
  });

  it("rejects an accepted ack that also includes a reason", () => {
    expect(validateCommandAck({ ...acceptedAck, accepted: true, reason: "EXPIRED" })).toBe(false);
  });

  it("rejects a free-text reason outside the safe error code enum", () => {
    expect(
      validateCommandAck({
        ...acceptedAck,
        accepted: false,
        reason: "the S3 bucket policy denied access to key xyz",
      }),
    ).toBe(false);
  });

  it("rejects a payload missing commandId", () => {
    const { commandId: _commandId, ...rest } = acceptedAck;
    expect(validateCommandAck(rest)).toBe(false);
  });

  it("rejects a payload missing eventId", () => {
    const { eventId: _eventId, ...rest } = acceptedAck;
    expect(validateCommandAck(rest)).toBe(false);
  });

  it("rejects a payload with a malformed eventId", () => {
    expect(validateCommandAck({ ...acceptedAck, eventId: "not-a-uuid" })).toBe(false);
  });

  it("rejects a calendar-invalid occurredAt", () => {
    expect(validateCommandAck({ ...acceptedAck, occurredAt: "2026-02-30T10:00:00Z" })).toBe(false);
  });
});
