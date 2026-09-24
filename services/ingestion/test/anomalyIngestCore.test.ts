import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { validateSensorAnomaly, validateVisualAnomaly } from "@sensecare/contracts";
import { processAnomalyRecord } from "../src/anomalyIngestCore.js";
import { DeviceIdMismatchError } from "../src/envelope.js";
import { config } from "../src/config.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

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

// Simula el envelope real que la IoT Rule entrega (SELECT *, topic(4) AS
// mqttDeviceId). mqttDeviceId nunca forma parte del contrato en si.
const validEnvelope = { ...validVisualAnomaly, mqttDeviceId: validVisualAnomaly.deviceId };

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  ddbMock
    .on(GetCommand)
    .resolves({ Item: { deviceId: "pi-demo-01", recipientId: "recipient-demo-01" } });
  ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: "eb-1" }] });
});

describe("processAnomalyRecord", () => {
  it("mints a caseId, logs the event and publishes to EventBridge for a brand-new anomaly", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    const lockPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === config.openCaseLocksTableName);
    expect(lockPut).toBeDefined();

    const eventLogPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === config.eventLogTableName);
    expect(eventLogPut?.args[0].input.Item?.recipientId).toBe("recipient-demo-01");

    const publishCalls = ebMock.commandCalls(PutEventsCommand);
    expect(publishCalls).toHaveLength(1);
    const detail = JSON.parse(publishCalls[0]?.args[0].input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.recipientId).toBe("recipient-demo-01");
    expect(detail.deviceId).toBe("pi-demo-01");
    expect(detail.caseId).toBe(lockPut?.args[0].input.Item?.caseId);
  });

  it("reuses the existing caseId (does not mint a new one) when the lock already exists", async () => {
    ddbMock
      .on(PutCommand, { TableName: config.openCaseLocksTableName })
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(PutCommand, { TableName: config.eventLogTableName }).resolves({});
    ddbMock.on(GetCommand, { TableName: config.openCaseLocksTableName }).resolves({
      Item: { lockKey: "recipient-demo-01#PERSON_PRONE_INACTIVE", caseId: "existing-case-id" },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    const publishCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(publishCalls[0]?.args[0].input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.caseId).toBe("existing-case-id");
  });

  it("requests a lock PutItem condition that allows reusing an already-expired lock", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    const lockPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === config.openCaseLocksTableName);
    expect(lockPut?.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(lockKey) OR expiresAt <= :now",
    );
    const sentNow = lockPut?.args[0].input.ExpressionAttributeValues?.[":now"] as number;
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    expect(typeof sentNow).toBe("number");
    expect(Math.abs(sentNow - nowEpochSeconds)).toBeLessThan(5);
  });

  it("uses a strongly consistent read when checking an existing lock", async () => {
    ddbMock
      .on(PutCommand, { TableName: config.openCaseLocksTableName })
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(PutCommand, { TableName: config.eventLogTableName }).resolves({});
    ddbMock.on(GetCommand, { TableName: config.openCaseLocksTableName }).resolves({
      Item: { lockKey: "recipient-demo-01#PERSON_PRONE_INACTIVE", caseId: "existing-case-id" },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    const lockGet = ddbMock
      .commandCalls(GetCommand)
      .find((c) => c.args[0].input.TableName === config.openCaseLocksTableName);
    expect(lockGet?.args[0].input.ConsistentRead).toBe(true);
  });

  it("still attempts to publish even when the EventLog write is a duplicate (redelivery)", async () => {
    ddbMock.on(PutCommand, { TableName: config.openCaseLocksTableName }).resolves({});
    ddbMock
      .on(PutCommand, { TableName: config.eventLogTableName })
      .rejects(new ConditionalCheckFailedException({ message: "dup", $metadata: {} }));
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
  });

  it("skips publishing when another invocation already holds the publish lease", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock
      .on(UpdateCommand, { UpdateExpression: "SET publishLeaseExpiresAt = :leaseExpiresAt" })
      .rejects(new ConditionalCheckFailedException({ message: "leased", $metadata: {} }));

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("requires eventBridgePublishedAt to be unset before acquiring the publish lease", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    const leaseUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.UpdateExpression === "SET publishLeaseExpiresAt = :leaseExpiresAt");
    expect(leaseUpdate?.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(eventBridgePublishedAt) AND (attribute_not_exists(publishLeaseExpiresAt) OR publishLeaseExpiresAt < :now)",
    );
  });

  it("does not republish to EventBridge once eventBridgePublishedAt is already set for the case", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock
      .on(UpdateCommand, { UpdateExpression: "SET publishLeaseExpiresAt = :leaseExpiresAt" })
      .rejects(new ConditionalCheckFailedException({ message: "already published", $metadata: {} }));

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("throws when EventBridge reports a partial failure, so the caller reports a batch item failure", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "boom" }],
    });

    await expect(
      processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly),
    ).rejects.toThrow();
  });

  it("does not record eventBridgePublishedAt when PutEvents partially fails", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "boom" }],
    });

    await expect(
      processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly),
    ).rejects.toThrow();

    const auditUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.UpdateExpression === "SET eventBridgePublishedAt = :publishedAt");
    expect(auditUpdate).toBeUndefined();
  });

  it("rejects a payload with an extra recipientId field before any write happens", async () => {
    const tampered = { ...validEnvelope, recipientId: "recipient-demo-01" };

    await expect(
      processAnomalyRecord(JSON.stringify(tampered), validateVisualAnomaly),
    ).rejects.toThrow();

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("propagates an unknown deviceId with zero writes and zero EventBridge publishes", async () => {
    ddbMock.on(GetCommand).resolves({});

    await expect(
      processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly),
    ).rejects.toThrow();

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("rejects when mqttDeviceId is missing from the envelope, with zero writes", async () => {
    await expect(
      processAnomalyRecord(JSON.stringify(validVisualAnomaly), validateVisualAnomaly), // sin mqttDeviceId
    ).rejects.toThrow();

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it("propagates severity into the EventBridge detail for a SENSOR_ANOMALY", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const sensorAnomaly = {
      eventId: "33333333-3333-4333-9333-333333333333",
      eventType: "SENSOR_ANOMALY",
      deviceId: "pi-demo-01",
      occurredAt: "2026-09-23T18:30:00Z",
      anomalyType: "TEMPERATURE_ALERT",
      severity: "critical",
      sensorRule: { ruleVersion: "sensor-rules-v1", windowSeconds: 60, trigger: "temp_rise" },
      sensors: { temperatureC: 55 },
    };
    const envelope = { ...sensorAnomaly, mqttDeviceId: sensorAnomaly.deviceId };

    await processAnomalyRecord(JSON.stringify(envelope), validateSensorAnomaly);

    const publishCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(publishCalls[0]?.args[0].input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.severity).toBe("critical");
  });

  it("never includes severity in the EventBridge detail for a VISUAL_ANOMALY", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await processAnomalyRecord(JSON.stringify(validEnvelope), validateVisualAnomaly);

    const publishCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(publishCalls[0]?.args[0].input.Entries?.[0]?.Detail ?? "{}");
    expect(detail).not.toHaveProperty("severity");
  });

  it("rejects a spoofed deviceId (topic pi-demo-01, payload pi-demo-02) with zero writes and zero EventBridge", async () => {
    const spoofed = { ...validVisualAnomaly, deviceId: "pi-demo-02", mqttDeviceId: "pi-demo-01" };

    await expect(
      processAnomalyRecord(JSON.stringify(spoofed), validateVisualAnomaly),
    ).rejects.toBeInstanceOf(DeviceIdMismatchError);

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
});
