import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { handler } from "../src/telemetryIngestHandler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

function sqsEventFor(body: unknown, messageId = "msg-1"): SQSEvent {
  return {
    Records: [
      {
        messageId,
        body: JSON.stringify(body),
        receiptHandle: "rh",
        attributes: {} as never,
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
        awsRegion: "us-east-1",
      },
    ],
  };
}

const validTelemetry = {
  eventId: "11111111-1111-4111-8111-111111111111",
  deviceId: "pi-demo-01",
  occurredAt: "2026-09-23T18:30:00Z",
  firmwareVersion: "0.1.0",
  temperatureC: 27.3,
};

/** Simula el envelope real que la IoT Rule entrega (SELECT *, topic(4) AS mqttDeviceId). */
function withMqttEnvelope(payload: Record<string, unknown>, mqttDeviceId = payload.deviceId as string) {
  return { ...payload, mqttDeviceId };
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock
    .on(GetCommand)
    .resolves({ Item: { deviceId: "pi-demo-01", recipientId: "recipient-demo-01" } });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

describe("telemetryIngestHandler", () => {
  it("persists a valid telemetry reading with the recipientId resolved from Devices", async () => {
    const result = await handler(sqsEventFor(withMqttEnvelope(validTelemetry)));

    expect(result.batchItemFailures).toHaveLength(0);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.args[0].input.Item?.recipientId).toBe("recipient-demo-01");
    expect(putCalls[0]?.args[0].input.Item?.deviceId).toBe("pi-demo-01");
    // mqttDeviceId es metadato de transporte: nunca debe llegar a DynamoDB.
    expect(putCalls[0]?.args[0].input.Item).not.toHaveProperty("mqttDeviceId");
  });

  it("rejects a payload with an extra recipientId field: schema rejection, zero writes", async () => {
    const tampered = withMqttEnvelope({ ...validTelemetry, recipientId: "recipient-demo-01" });

    const result = await handler(sqsEventFor(tampered));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("reports a batch item failure and writes nothing for an unknown deviceId", async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(sqsEventFor(withMqttEnvelope(validTelemetry)));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("treats a duplicate eventId (SQS redelivery) as an idempotent no-op", async () => {
    const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: "dup", $metadata: {} }));

    const result = await handler(sqsEventFor(withMqttEnvelope(validTelemetry)));

    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("reports a batch item failure and writes nothing when mqttDeviceId is missing", async () => {
    const result = await handler(sqsEventFor(validTelemetry)); // sin mqttDeviceId

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("rejects a spoofed deviceId: topic says pi-demo-01, payload claims pi-demo-02", async () => {
    const spoofed = { ...validTelemetry, deviceId: "pi-demo-02", mqttDeviceId: "pi-demo-01" };

    const result = await handler(sqsEventFor(spoofed));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
