import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { SQSEvent } from "aws-lambda";
import { handler } from "../src/visualAnomalyIngestHandler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

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

const validVisualAnomaly = {
  eventId: "22222222-2222-4222-9222-222222222222",
  eventType: "VISUAL_ANOMALY",
  deviceId: "pi-demo-01",
  occurredAt: "2026-09-23T18:30:00Z",
  anomalyType: "PERSON_PRONE_INACTIVE",
  confidence: 0.87,
  candidates: ["POSSIBLE_FALL"],
  evidence: { personCount: 1, zone: "living_room" },
  modelVersions: { pose: "pose-v1", person: "person-v1" },
};

/** Simula el envelope real que la IoT Rule entrega (SELECT *, topic(4) AS mqttDeviceId). */
function withMqttEnvelope(payload: Record<string, unknown>, mqttDeviceId = payload.deviceId as string) {
  return { ...payload, mqttDeviceId };
}

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  ddbMock
    .on(GetCommand)
    .resolves({ Item: { deviceId: "pi-demo-01", recipientId: "recipient-demo-01" } });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: "eb-1" }] });
});

describe("visualAnomalyIngestHandler", () => {
  it("publishes to EventBridge with the recipientId resolved from Devices", async () => {
    const result = await handler(sqsEventFor(withMqttEnvelope(validVisualAnomaly)));

    expect(result.batchItemFailures).toHaveLength(0);

    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0]?.args[0].input.Entries?.[0]?.Detail ?? "{}",
    );
    expect(detail.recipientId).toBe("recipient-demo-01");
  });

  it("rejects a payload with an extra recipientId field: schema rejection, zero writes", async () => {
    const tampered = withMqttEnvelope({ ...validVisualAnomaly, recipientId: "recipient-demo-01" });

    const result = await handler(sqsEventFor(tampered));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("reports a batch item failure and writes nothing for an unknown deviceId", async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(sqsEventFor(withMqttEnvelope(validVisualAnomaly)));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("reports a batch item failure and writes nothing when mqttDeviceId is missing", async () => {
    const result = await handler(sqsEventFor(validVisualAnomaly)); // sin mqttDeviceId

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("rejects a spoofed deviceId: topic says pi-demo-01, payload claims pi-demo-02", async () => {
    const spoofed = { ...validVisualAnomaly, deviceId: "pi-demo-02", mqttDeviceId: "pi-demo-01" };

    const result = await handler(sqsEventFor(spoofed));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
});
