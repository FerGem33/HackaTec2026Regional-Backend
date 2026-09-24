import { randomUUID } from "node:crypto";
import type { Telemetry } from "@sensecare/contracts";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function generateTelemetry(deviceId: string): Telemetry {
  return {
    eventId: randomUUID(),
    deviceId,
    occurredAt: new Date().toISOString(),
    firmwareVersion: "0.1.0",
    temperatureC: round1(22 + Math.random() * 8),
    humidityPct: round1(35 + Math.random() * 30),
    co2Ppm: Math.round(500 + Math.random() * 900),
    proximityCm: Math.round(50 + Math.random() * 200),
    motion: Math.random() > 0.7,
  };
}
