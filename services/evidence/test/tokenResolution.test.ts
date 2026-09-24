import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  InvalidToken,
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  SFNClient,
  TaskDoesNotExist,
  TaskTimedOut,
} from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { resolveTaskToken, resolveWithLease } from "../src/tokenResolution.js";
import type { EvidenceCallbackRecord } from "../src/callbackStore.js";

const sfnMock = mockClient(SFNClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = "SenseCare-EvidenceCallbacks-test";

function existingRecord(overrides: Partial<EvidenceCallbackRecord>): EvidenceCallbackRecord {
  return {
    caseId: "case-1",
    callbackType: "IMAGE_EVIDENCE",
    commandId: "cmd-1",
    imageId: "img-1",
    expectedS3Key: "raw-images/recipient-demo-01/case-1/img-1.jpg",
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    reason: "LOCAL_VISUAL_ANOMALY",
    captureMode: "BUFFERED",
    taskToken: "the-token",
    status: "PENDING",
    commandExpiresAt: "2026-09-24T18:31:00Z",
    createdAt: "2026-09-24T18:30:00Z",
    updatedAt: "2026-09-24T18:30:00Z",
    ttlEpochSeconds: 9999999999,
    ...overrides,
  };
}

beforeEach(() => {
  sfnMock.reset();
  ddbMock.reset();
});

describe("resolveWithLease", () => {
  it("resolves to RESOLVED when SendTaskSuccess responds without error", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) }); // acquire lease returns ALL_NEW
    sfnMock.on(SendTaskSuccessCommand).resolves({});
    ddbMock.on(UpdateCommand, { UpdateExpression: expect.stringContaining("resolved") }).resolves({});

    const outcome = await resolveWithLease(TABLE, "case-1", "cmd-1", 30, "UPLOADED", { outcome: "UPLOADED" }, undefined);

    expect(outcome).toBe("RESOLVED");
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
  });

  it("returns NOOP_CONTENDED without calling SendTask* when the lease cannot be acquired", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "contended", $metadata: {} }));

    const outcome = await resolveWithLease(TABLE, "case-1", "cmd-1", 30, "UPLOADED", undefined, undefined);

    expect(outcome).toBe("NOOP_CONTENDED");
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(0);
  });

  it.each([
    ["InvalidToken", new InvalidToken({ message: "bad token", $metadata: {} })],
    ["TaskDoesNotExist", new TaskDoesNotExist({ message: "gone", $metadata: {} })],
    ["TaskTimedOut", new TaskTimedOut({ message: "timed out", $metadata: {} })],
  ])(
    "does NOT mark RESOLVED on %s: sets UNCONFIRMED instead, never assumes success",
    async (_name, error) => {
      // Adquiere el lease (ALL_NEW) y luego el intento de resolver falla.
      let updateCallCount = 0;
      ddbMock.on(UpdateCommand).callsFake(() => {
        updateCallCount += 1;
        if (updateCallCount === 1) {
          return { Attributes: existingRecord({}) }; // acquire
        }
        return {}; // release-as-unconfirmed
      });
      sfnMock.on(SendTaskFailureCommand).rejects(error);

      const outcome = await resolveWithLease(TABLE, "case-1", "cmd-1", 30, "UPLOAD_FAILED", undefined, "x");

      expect(outcome).toBe("UNCONFIRMED");
      // La segunda llamada UpdateCommand debe ser la liberacion a UNCONFIRMED,
      // nunca un finalize a RESOLVED.
      const secondUpdateInput = ddbMock.commandCalls(UpdateCommand)[1]?.args[0].input;
      expect(secondUpdateInput?.ExpressionAttributeValues?.[":unconfirmed"]).toBe("UNCONFIRMED");
      expect(JSON.stringify(secondUpdateInput?.ExpressionAttributeValues)).not.toContain("RESOLVED");
    },
  );

  it("rethrows genuine transient errors (not the token-invalid family), leaving the lease to expire naturally", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({}) });
    sfnMock.on(SendTaskFailureCommand).rejects(new Error("ThrottlingException"));

    await expect(
      resolveWithLease(TABLE, "case-1", "cmd-1", 30, "UPLOAD_FAILED", undefined, "x"),
    ).rejects.toThrow("ThrottlingException");

    // No debe haber un segundo UpdateCommand (ni UNCONFIRMED ni RESOLVED):
    // el error se propaga tal cual para que SQS reintente.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });
});

describe("resolveTaskToken (best-effort, no lease/table)", () => {
  it("calls SendTaskSuccess for the UPLOADED outcome", async () => {
    sfnMock.on(SendTaskSuccessCommand).resolves({});
    await resolveTaskToken("some-token", "UPLOADED");
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
  });

  it("calls SendTaskFailure for non-UPLOADED outcomes", async () => {
    sfnMock.on(SendTaskFailureCommand).resolves({});
    await resolveTaskToken("some-token", "TIMEOUT", "States.Timeout");
    expect(sfnMock.commandCalls(SendTaskFailureCommand)).toHaveLength(1);
  });

  it("swallows errors without throwing (best-effort)", async () => {
    sfnMock.on(SendTaskFailureCommand).rejects(new Error("boom"));
    await expect(resolveTaskToken("some-token", "TIMEOUT")).resolves.toBeUndefined();
  });
});
