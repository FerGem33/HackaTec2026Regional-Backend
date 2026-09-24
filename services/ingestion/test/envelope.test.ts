import { describe, expect, it } from "vitest";
import { DeviceIdMismatchError, extractVerifiedPayload } from "../src/envelope.js";

const basePayload = {
  eventId: "11111111-1111-4111-8111-111111111111",
  deviceId: "pi-demo-01",
  occurredAt: "2026-09-23T18:30:00Z",
  firmwareVersion: "0.1.0",
};

describe("extractVerifiedPayload", () => {
  it("strips mqttDeviceId and returns the clean payload when it matches payload.deviceId", () => {
    const envelope = { ...basePayload, mqttDeviceId: "pi-demo-01" };

    const result = extractVerifiedPayload(JSON.stringify(envelope));

    expect(result).toEqual(basePayload);
    expect(result).not.toHaveProperty("mqttDeviceId");
  });

  it("throws when mqttDeviceId is missing from the envelope", () => {
    expect(() => extractVerifiedPayload(JSON.stringify(basePayload))).toThrow();
  });

  it("throws when mqttDeviceId is an empty string", () => {
    const envelope = { ...basePayload, mqttDeviceId: "" };
    expect(() => extractVerifiedPayload(JSON.stringify(envelope))).toThrow();
  });

  it("throws when mqttDeviceId is not a string", () => {
    const envelope = { ...basePayload, mqttDeviceId: 12345 };
    expect(() => extractVerifiedPayload(JSON.stringify(envelope))).toThrow();
  });

  it("throws DeviceIdMismatchError when mqttDeviceId does not match payload.deviceId (spoofing)", () => {
    // Topic dice pi-demo-01, el payload afirma ser pi-demo-02.
    const envelope = { ...basePayload, deviceId: "pi-demo-02", mqttDeviceId: "pi-demo-01" };

    expect(() => extractVerifiedPayload(JSON.stringify(envelope))).toThrow(DeviceIdMismatchError);
  });

  it("throws when payload.deviceId is missing entirely", () => {
    const { deviceId: _deviceId, ...rest } = basePayload;
    const envelope = { ...rest, mqttDeviceId: "pi-demo-01" };

    expect(() => extractVerifiedPayload(JSON.stringify(envelope))).toThrow(DeviceIdMismatchError);
  });
});
