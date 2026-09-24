import { describe, expect, it } from "vitest";
import { isValidUtcDateTime } from "../src/formats.js";

describe("isValidUtcDateTime", () => {
  it("accepts a plain valid UTC timestamp", () => {
    expect(isValidUtcDateTime("2026-09-23T18:30:00Z")).toBe(true);
  });

  it("accepts a valid UTC timestamp with fractional seconds", () => {
    expect(isValidUtcDateTime("2026-09-23T18:30:00.123Z")).toBe(true);
  });

  it("accepts February 29th on a leap year", () => {
    expect(isValidUtcDateTime("2024-02-29T00:00:00Z")).toBe(true);
  });

  it("rejects February 29th on a non-leap year", () => {
    expect(isValidUtcDateTime("2025-02-29T00:00:00Z")).toBe(false);
  });

  it("rejects April 31st (April has 30 days)", () => {
    expect(isValidUtcDateTime("2026-04-31T00:00:00Z")).toBe(false);
  });

  it("rejects month 13", () => {
    expect(isValidUtcDateTime("2026-13-01T00:00:00Z")).toBe(false);
  });

  it("rejects month 00", () => {
    expect(isValidUtcDateTime("2026-00-01T00:00:00Z")).toBe(false);
  });

  it("rejects day 00", () => {
    expect(isValidUtcDateTime("2026-01-00T00:00:00Z")).toBe(false);
  });

  it("rejects hour 24", () => {
    expect(isValidUtcDateTime("2026-01-01T24:00:00Z")).toBe(false);
  });

  it("rejects minute 60", () => {
    expect(isValidUtcDateTime("2026-01-01T00:60:00Z")).toBe(false);
  });

  it("rejects second 60 (no leap-second support)", () => {
    expect(isValidUtcDateTime("2026-01-01T00:00:60Z")).toBe(false);
  });

  it("rejects a missing trailing Z", () => {
    expect(isValidUtcDateTime("2026-01-01T00:00:00")).toBe(false);
  });

  it("rejects a numeric UTC offset instead of Z", () => {
    expect(isValidUtcDateTime("2026-01-01T00:00:00+00:00")).toBe(false);
  });

  it("rejects a lowercase t/z", () => {
    expect(isValidUtcDateTime("2026-01-01t00:00:00z")).toBe(false);
  });
});
