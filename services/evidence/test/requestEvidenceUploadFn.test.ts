import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";

// getSignedUrl no pasa por .send(): no es interceptable con aws-sdk-client-mock.
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://example-bucket.s3.amazonaws.com/signed"),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const iotMock = mockClient(IoTDataPlaneClient);
const sfnMock = mockClient(SFNClient);

const { handler } = await import("../src/requestEvidenceUploadFn.js");
const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
import type { EvidenceCallbackRecord } from "../src/callbackStore.js";
import type { RequestEvidenceUploadInput } from "../src/requestEvidenceUploadFn.js";

const CASE_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "22222222-2222-4222-9222-222222222222";
const EXISTING_COMMAND_ID = "44444444-4444-4444-b444-444444444444";
const EXISTING_IMAGE_ID = "66666666-6666-4666-9666-666666666666";

const input: RequestEvidenceUploadInput = {
  caseDetail: {
    caseId: CASE_ID,
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    eventId: EVENT_ID,
    eventType: "VISUAL_ANOMALY",
    anomalyType: "PERSON_PRONE_INACTIVE",
    occurredAt: "2026-09-24T18:30:00Z",
  },
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
  taskToken: "task-token-1",
};

function existingRecord(overrides: Partial<EvidenceCallbackRecord>): EvidenceCallbackRecord {
  return {
    caseId: CASE_ID,
    callbackType: "IMAGE_EVIDENCE",
    commandId: EXISTING_COMMAND_ID,
    imageId: EXISTING_IMAGE_ID,
    expectedS3Key: `raw-images/recipient-demo-01/${CASE_ID}/${EXISTING_IMAGE_ID}.jpg`,
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    reason: "LOCAL_VISUAL_ANOMALY",
    captureMode: "BUFFERED",
    taskToken: "old-token",
    status: "PENDING",
    commandExpiresAt: "2026-09-24T18:31:00Z",
    createdAt: "2026-09-24T18:30:00Z",
    updatedAt: "2026-09-24T18:30:00Z",
    ttlEpochSeconds: 9999999999,
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  iotMock.reset();
  sfnMock.reset();
  vi.mocked(getSignedUrl).mockClear();
  iotMock.on(PublishCommand).resolves({});
});

function decodePublishedCommand(callIndex = 0): Record<string, unknown> {
  const publishInput = iotMock.commandCalls(PublishCommand)[callIndex]?.args[0].input;
  return JSON.parse(new TextDecoder().decode(publishInput?.payload as Uint8Array));
}

describe("requestEvidenceUploadFn", () => {
  it("VISUAL_ANOMALY -> BUFFERED/LOCAL_VISUAL_ANOMALY; publishes and logs EVIDENCE_REQUESTED", async () => {
    ddbMock.on(PutCommand, { TableName: "SenseCare-EvidenceCallbacks-test" }).resolves({});
    ddbMock.on(PutCommand, { TableName: "SenseCare-EventLog-test" }).resolves({});

    await handler(input);

    const publishInput = iotMock.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publishInput?.topic).toBe("SenseCare/v1/devices/pi-demo-01/commands");
    const command = decodePublishedCommand();
    expect(command.reason).toBe("LOCAL_VISUAL_ANOMALY");
    expect(command.captureMode).toBe("BUFFERED");
    expect(command.caseId).toBe(CASE_ID);

    const eventLogCall = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EventLog-test");
    expect(eventLogCall?.args[0].input.Item?.eventType).toBe("EVIDENCE_REQUESTED");
  });

  it("SENSOR_ANOMALY -> CURRENT/SENSOR_ANOMALY", async () => {
    ddbMock.on(PutCommand).resolves({});

    await handler({
      ...input,
      caseDetail: { ...input.caseDetail, eventType: "SENSOR_ANOMALY", anomalyType: "TEMPERATURE_ALERT" },
    });

    const command = decodePublishedCommand();
    expect(command.reason).toBe("SENSOR_ANOMALY");
    expect(command.captureMode).toBe("CURRENT");
  });

  it("retry while ACK_ACCEPTED: republishes with a renewed uploadUrl, same commandId/s3Key/expiresAt, status untouched", async () => {
    ddbMock
      .on(PutCommand, { TableName: "SenseCare-EvidenceCallbacks-test" })
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    const existing = existingRecord({ status: "ACK_ACCEPTED" });
    ddbMock.on(GetCommand).resolves({ Item: existing });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand, { TableName: "SenseCare-EventLog-test" }).resolves({});

    await handler(input);

    const command = decodePublishedCommand();
    expect(command.commandId).toBe(existing.commandId);
    expect(command.s3Key).toBe(existing.expectedS3Key);
    expect(command.expiresAt).toBe(existing.commandExpiresAt);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.UpdateExpression).not.toContain("status");
  });

  it("race: a retry landing while a concurrent evidence callback holds RESOLVING must not touch taskToken or republish", async () => {
    ddbMock
      .on(PutCommand, { TableName: "SenseCare-EvidenceCallbacks-test" })
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "RESOLVING" }) });

    await handler(input);

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(iotMock.commandCalls(PublishCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(0);
  });

  it("late retry after RESOLVED: resolves this invocation's token directly, without republishing or touching the table", async () => {
    ddbMock
      .on(PutCommand, { TableName: "SenseCare-EvidenceCallbacks-test" })
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({
      Item: existingRecord({ status: "RESOLVED", resolvedOutcomeType: "UPLOADED" }),
    });
    sfnMock.on(SendTaskSuccessCommand).resolves({});

    await handler(input);

    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    const call = sfnMock.commandCalls(SendTaskSuccessCommand)[0]?.args[0].input;
    expect(call?.taskToken).toBe(input.taskToken);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(iotMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it("s3Key and expiresAt are invariant across repeated calls for the same case (backend never triggers COMMAND_CONFLICT itself)", async () => {
    ddbMock.on(PutCommand, { TableName: "SenseCare-EvidenceCallbacks-test" }).resolvesOnce({});
    ddbMock.on(PutCommand, { TableName: "SenseCare-EventLog-test" }).resolves({});

    await handler(input);
    const firstCommand = decodePublishedCommand(0);

    const createdItem = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EvidenceCallbacks-test")?.args[0].input.Item as
      | EvidenceCallbackRecord
      | undefined;

    ddbMock
      .on(PutCommand, { TableName: "SenseCare-EvidenceCallbacks-test" })
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: createdItem });
    ddbMock.on(UpdateCommand).resolves({});

    await handler({ ...input, taskToken: "task-token-2" });
    const secondCommand = decodePublishedCommand(1);

    expect(secondCommand.commandId).toBe(firstCommand.commandId);
    expect(secondCommand.s3Key).toBe(firstCommand.s3Key);
    expect(secondCommand.expiresAt).toBe(firstCommand.expiresAt);
  });
});
