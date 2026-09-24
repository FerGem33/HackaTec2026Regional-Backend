import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { handler } from "../src/demoIngestHandler.js";

const sqsMock = mockClient(SQSClient);

function requestFor(deviceId: string, body: unknown): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { deviceId },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const validTelemetry = {
  eventId: "11111111-1111-4111-8111-111111111111",
  deviceId: "sim-room-01",
  occurredAt: "2026-09-24T18:30:00Z",
  firmwareVersion: "1.0.0",
  temperatureC: 24.1,
};

const validSensorAnomaly = {
  eventId: "22222222-2222-4222-8222-222222222222",
  eventType: "SENSOR_ANOMALY",
  deviceId: "sim-room-01",
  occurredAt: "2026-09-24T18:31:00Z",
  anomalyType: "POOR_AIR_QUALITY",
  severity: "warning",
  sensorRule: { ruleVersion: "demo-air-v1", windowSeconds: 120, trigger: "co2Ppm >= 1200 sostenido" },
  sensors: { co2Ppm: 1350 },
};

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({ MessageId: "sqs-msg-1" });
});

describe("demoIngestHandler", () => {
  it("accepts valid telemetry and forwards it to the telemetry queue with mqttDeviceId attached", async () => {
    const result = await handler(requestFor("sim-room-01", validTelemetry));

    expect(result).toMatchObject({ statusCode: 202 });
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.QueueUrl).toBe(process.env.DEMO_TELEMETRY_QUEUE_URL);
    const sentBody = JSON.parse(calls[0]?.args[0].input.MessageBody as string);
    expect(sentBody.mqttDeviceId).toBe("sim-room-01");
    expect(sentBody.deviceId).toBe("sim-room-01");
  });

  it("accepts a valid SENSOR_ANOMALY and forwards it to the sensor-anomaly queue", async () => {
    const result = await handler(requestFor("sim-room-01", validSensorAnomaly));

    expect(result).toMatchObject({ statusCode: 202 });
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls[0]?.args[0].input.QueueUrl).toBe(process.env.DEMO_SENSOR_ANOMALY_QUEUE_URL);
  });

  it("rejects a deviceId that is not on the demo allowlist, without touching SQS", async () => {
    const result = await handler(
      requestFor("pi-demo-01", { ...validTelemetry, deviceId: "pi-demo-01" }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("rejects a path/body deviceId mismatch (anti-spoofing), without touching SQS", async () => {
    const result = await handler(requestFor("sim-room-01", { ...validTelemetry, deviceId: "sim-room-02" }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("rejects VISUAL_ANOMALY: only the Pi's real camera may produce it", async () => {
    const result = await handler(
      requestFor("sim-room-01", { ...validSensorAnomaly, eventType: "VISUAL_ANOMALY" }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("rejects telemetry that fails schema validation, without touching SQS", async () => {
    const result = await handler(
      requestFor("sim-room-01", { ...validTelemetry, temperatureC: 999 }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("rejects malformed JSON with a 400 instead of throwing", async () => {
    const event = {
      pathParameters: { deviceId: "sim-room-01" },
      body: "{not json",
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
