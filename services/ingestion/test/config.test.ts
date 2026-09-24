import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NUMERIC_VARS = [
  "OPEN_CASE_LOCK_TTL_SECONDS",
  "PUBLISH_LEASE_SECONDS",
  "TELEMETRY_RETENTION_DAYS",
] as const;

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function loadConfig() {
  return import("../src/config.js");
}

describe("config", () => {
  it("loads the defaults provided by setupEnv.ts as positive integers", async () => {
    const { config } = await loadConfig();
    expect(config.openCaseLockTtlSeconds).toBe(7200);
    expect(config.publishLeaseSeconds).toBe(10);
    expect(config.telemetryRetentionDays).toBe(60);
  });

  it("throws when a required table/bus name env var is missing", async () => {
    delete process.env.DEVICES_TABLE_NAME;
    await expect(loadConfig()).rejects.toThrow(/DEVICES_TABLE_NAME/);
  });

  it.each(NUMERIC_VARS)("throws at cold start when %s is not a number", async (varName) => {
    process.env[varName] = "not-a-number";
    await expect(loadConfig()).rejects.toThrow(/entero positivo/);
  });

  it.each(NUMERIC_VARS)("throws at cold start when %s is zero", async (varName) => {
    process.env[varName] = "0";
    await expect(loadConfig()).rejects.toThrow(/entero positivo/);
  });

  it.each(NUMERIC_VARS)("throws at cold start when %s is negative", async (varName) => {
    process.env[varName] = "-5";
    await expect(loadConfig()).rejects.toThrow(/entero positivo/);
  });

  it.each(NUMERIC_VARS)("throws at cold start when %s is a fractional number", async (varName) => {
    process.env[varName] = "3.5";
    await expect(loadConfig()).rejects.toThrow(/entero positivo/);
  });

  it.each(NUMERIC_VARS)("accepts %s when it is a valid positive integer string", async (varName) => {
    process.env[varName] = "42";
    const { config } = await loadConfig();
    const key = {
      OPEN_CASE_LOCK_TTL_SECONDS: "openCaseLockTtlSeconds",
      PUBLISH_LEASE_SECONDS: "publishLeaseSeconds",
      TELEMETRY_RETENTION_DAYS: "telemetryRetentionDays",
    }[varName] as keyof typeof config;
    expect(config[key]).toBe(42);
  });
});
