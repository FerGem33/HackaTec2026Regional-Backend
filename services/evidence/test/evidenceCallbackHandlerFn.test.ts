import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { handler } from "../src/evidenceCallbackHandlerFn.js";
import type { EvidenceCallbackRecord } from "../src/callbackStore.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const sfnMock = mockClient(SFNClient);

const CASE_ID = "55555555-5555-4555-8555-555555555555";
const COMMAND_ID = "44444444-4444-4444-b444-444444444444";
const IMAGE_ID = "66666666-6666-4666-9666-666666666666";
const EVENT_ID = "22222222-2222-4222-9222-222222222222";
const FUTURE_EXPIRY = "2999-01-01T00:00:00Z";
const S3_KEY = `raw-images/recipient-demo-01/${CASE_ID}/${IMAGE_ID}.jpg`;

function existingRecord(overrides: Partial<EvidenceCallbackRecord>): EvidenceCallbackRecord {
  return {
    caseId: CASE_ID,
    callbackType: "IMAGE_EVIDENCE",
    commandId: COMMAND_ID,
    imageId: IMAGE_ID,
    expectedS3Key: S3_KEY,
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    reason: "LOCAL_VISUAL_ANOMALY",
    captureMode: "BUFFERED",
    taskToken: "the-token",
    status: "ACK_ACCEPTED",
    commandExpiresAt: FUTURE_EXPIRY,
    createdAt: "2026-09-24T18:30:00Z",
    updatedAt: "2026-09-24T18:30:00Z",
    ttlEpochSeconds: 9999999999,
    ...overrides,
  };
}

function makeRecord(body: Record<string, unknown>, mqttDeviceId = "pi-demo-01"): SQSRecord {
  return { messageId: "msg-1", body: JSON.stringify({ mqttDeviceId, ...body }) } as SQSRecord;
}

function makeEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

const uploadedBody = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  eventType: "EVIDENCE_UPLOADED" as const,
  occurredAt: "2026-09-24T18:30:45Z",
  s3Key: S3_KEY,
  imageId: IMAGE_ID,
};

const failedBody = {
  eventId: EVENT_ID,
  commandId: COMMAND_ID,
  caseId: CASE_ID,
  eventType: "EVIDENCE_FAILED" as const,
  occurredAt: "2026-09-24T18:30:45Z",
  errorCode: "UPLOAD_TIMEOUT" as const,
};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  sfnMock.reset();
});

describe("evidenceCallbackHandlerFn", () => {
  it("valid EVIDENCE_UPLOADED (correct key/imageId/Content-Type/size) resolves UPLOADED via SendTaskSuccess", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) }); // acquire lease + finalize
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/jpeg", ContentLength: 1024 });
    sfnMock.on(SendTaskSuccessCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(uploadedBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("s3Key/imageId mismatch resolves OBJECT_INVALID without even checking S3", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) });
    sfnMock.on(SendTaskFailureCommand).resolves({});

    const result = await handler(
      makeEvent([makeRecord({ ...uploadedBody, s3Key: `raw-images/recipient-demo-01/${CASE_ID}/${EVENT_ID}.jpg` })]),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
  });

  it("HeadObject missing (object never landed) resolves OBJECT_MISSING and does not attempt cleanup delete", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) });
    s3Mock.on(HeadObjectCommand).rejects(new Error("NotFound"));
    sfnMock.on(SendTaskFailureCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(uploadedBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
  });

  it("wrong Content-Type resolves OBJECT_INVALID and best-effort deletes the invalid object", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) });
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 1024 });
    s3Mock.on(DeleteObjectCommand).resolves({});
    sfnMock.on(SendTaskFailureCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(uploadedBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
  });

  it("oversized object resolves OBJECT_INVALID and best-effort deletes it, tolerating a failed delete", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) });
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/jpeg", ContentLength: 10 * 1024 * 1024 });
    s3Mock.on(DeleteObjectCommand).rejects(new Error("AccessDenied"));
    sfnMock.on(SendTaskFailureCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(uploadedBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
  });

  it("EVIDENCE_FAILED resolves UPLOAD_FAILED via SendTaskFailure without touching S3", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) });
    sfnMock.on(SendTaskFailureCommand).resolves({});

    const result = await handler(makeEvent([makeRecord(failedBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
  });

  it("ignores a callback for a case that already reached RESOLVED, without re-verifying the object (Pi restart replay)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "RESOLVED", resolvedOutcomeType: "UPLOADED" }) });

    const result = await handler(makeEvent([makeRecord(uploadedBody)]));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("rejects when mqttDeviceId does not match the deviceId stored for this case", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({}) });

    const result = await handler(makeEvent([makeRecord(uploadedBody, "other-device")]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
  });
});
