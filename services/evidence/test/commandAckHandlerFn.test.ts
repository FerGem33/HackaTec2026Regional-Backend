import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { handler } from "../src/commandAckHandlerFn.js";
import type { EvidenceCallbackRecord } from "../src/callbackStore.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const CASE_ID = "55555555-5555-4555-8555-555555555555";
const COMMAND_ID = "44444444-4444-4444-b444-444444444444";
const IMAGE_ID = "66666666-6666-4666-9666-666666666666";
const EVENT_ID = "22222222-2222-4222-9222-222222222222";
const FUTURE_EXPIRY = "2999-01-01T00:00:00Z";

function existingRecord(overrides: Partial<EvidenceCallbackRecord>): EvidenceCallbackRecord {
  return {
    caseId: CASE_ID,
    callbackType: "IMAGE_EVIDENCE",
    commandId: COMMAND_ID,
    imageId: IMAGE_ID,
    expectedS3Key: `raw-images/recipient-demo-01/${CASE_ID}/${IMAGE_ID}.jpg`,
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    reason: "LOCAL_VISUAL_ANOMALY",
    captureMode: "BUFFERED",
    taskToken: "the-token",
    status: "PENDING",
    commandExpiresAt: FUTURE_EXPIRY,
    createdAt: "2026-09-24T18:30:00Z",
    updatedAt: "2026-09-24T18:30:00Z",
    ttlEpochSeconds: 9999999999,
    ...overrides,
  };
}

function makeRecord(body: Record<string, unknown>, mqttDeviceId = "pi-demo-01"): SQSRecord {
  return {
    messageId: "msg-1",
    body: JSON.stringify({ mqttDeviceId, ...body }),
  } as SQSRecord;
}

function makeEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

const acceptedTrueBody = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  command: "UPLOAD_EVIDENCE" as const,
  occurredAt: "2026-09-24T18:30:30Z",
  accepted: true,
};

const acceptedFalseBody = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  command: "UPLOAD_EVIDENCE" as const,
  occurredAt: "2026-09-24T18:30:30Z",
  accepted: false,
  reason: "FRAME_NOT_AVAILABLE" as const,
};

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
});

describe("commandAckHandlerFn", () => {
  it("accepted:true advances PENDING->ACK_ACCEPTED and logs EVIDENCE_ACKNOWLEDGED, without calling SendTask*", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "PENDING" }) });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(acceptedTrueBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(0);
    const eventLogItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("EVIDENCE_ACKNOWLEDGED");
  });

  it("treats a duplicate accepted:true (already ACK_ACCEPTED) as an idempotent no-op", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "ACK_ACCEPTED" }) });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "dup", $metadata: {} }));
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(acceptedTrueBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("accepted:false resolves the case immediately via the resolution lease and logs EVIDENCE_REJECTED", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "PENDING" }) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({ status: "PENDING" }) }); // acquire lease (ALL_NEW)
    sfnMock.on(SendTaskFailureCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(acceptedFalseBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
    const eventLogItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("EVIDENCE_REJECTED");
    expect(eventLogItem?.reason).toBe("FRAME_NOT_AVAILABLE");
  });

  it("rejects when mqttDeviceId does not match the deviceId stored for this case (spoofing attempt)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "PENDING" }) });

    const result = await handler(makeEvent([makeRecord(acceptedTrueBody, "other-device")]));

    expect(result.batchItemFailures).toHaveLength(1);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(0);
  });

  it("ignores an ACK for a case that already reached RESOLVED without attempting any lease (Pi restart replay)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "RESOLVED", resolvedOutcomeType: "UPLOADED" }) });

    const result = await handler(makeEvent([makeRecord(acceptedTrueBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(0);
  });

  it("ignores an ACK that arrives after commandExpiresAt without erroring (Step Functions timeout owns INCOMPLETE)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: existingRecord({ status: "PENDING", commandExpiresAt: "2000-01-01T00:00:00Z" }),
    });

    const result = await handler(makeEvent([makeRecord(acceptedTrueBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("reports a batch item failure for a schema-invalid COMMAND_ACK", async () => {
    const result = await handler(
      makeEvent([makeRecord({ ...acceptedTrueBody, commandId: "not-a-uuid" })]),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
  });

  it("reports a batch item failure when no EvidenceCallbacks record exists for the caseId", async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(acceptedTrueBody)]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
  });
});
