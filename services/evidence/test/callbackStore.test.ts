import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  acquireResolutionLease,
  finalizeResolved,
  markAckAccepted,
  prepareUploadCommand,
  reconcileAfterWorkflowOutcome,
  releaseLeaseAsUnconfirmed,
  type EvidenceCallbackRecord,
} from "../src/callbackStore.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = "SenseCare-EvidenceCallbacks-test";

function mintS3Key(recipientId: string, caseId: string, imageId: string): string {
  return `raw-images/${recipientId}/${caseId}/${imageId}.jpg`;
}

const baseInput = {
  caseId: "case-1",
  deviceId: "pi-demo-01",
  recipientId: "recipient-demo-01",
  reason: "LOCAL_VISUAL_ANOMALY" as const,
  captureMode: "BUFFERED" as const,
  commandTimeoutSeconds: 60,
  ttlBufferSeconds: 3600,
};

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
});

describe("prepareUploadCommand", () => {
  it("creates a fresh record when none exists", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await prepareUploadCommand(TABLE, baseInput, "token-1", mintS3Key);

    expect(result.action).toBe("PUBLISH");
    if (result.action === "PUBLISH") {
      expect(result.s3Key).toBe(`raw-images/recipient-demo-01/case-1/${result.imageId}.jpg`);
    }
  });

  it("refreshes taskToken on retry while PENDING, keeping status PENDING and reusing commandId/imageId/s3Key/expiresAt", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    const existing = existingRecord({ status: "PENDING" });
    ddbMock.on(GetCommand).resolves({ Item: existing });
    ddbMock.on(UpdateCommand).resolves({});

    const first = await prepareUploadCommand(TABLE, baseInput, "token-2", mintS3Key);
    const second = await prepareUploadCommand(TABLE, baseInput, "token-3", mintS3Key);

    expect(first).toEqual({
      action: "PUBLISH",
      commandId: existing.commandId,
      imageId: existing.imageId,
      s3Key: existing.expectedS3Key,
      commandExpiresAt: existing.commandExpiresAt,
    });
    // Invariante: mismo commandId/s3Key/expiresAt en ambos intentos (nunca
    // cambian entre reintentos del backend).
    expect(second).toEqual(first);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.ConditionExpression).toContain("#status = :pending OR #status = :ackAccepted");
  });

  it("refreshes taskToken on retry while ACK_ACCEPTED, without resetting status back to PENDING", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    const existing = existingRecord({ status: "ACK_ACCEPTED" });
    ddbMock.on(GetCommand).resolves({ Item: existing });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await prepareUploadCommand(TABLE, baseInput, "token-new", mintS3Key);

    expect(result.action).toBe("PUBLISH");
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    // Solo toca taskToken/updatedAt; nunca escribe #status en esta rama.
    expect(updateCall?.UpdateExpression).toBe("SET taskToken = :token, updatedAt = :now");
  });

  it("does nothing (NOOP) when a retry lands while RESOLVING", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "RESOLVING" }) });

    const result = await prepareUploadCommand(TABLE, baseInput, "token-x", mintS3Key);

    expect(result).toEqual({ action: "NOOP" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("does nothing (NOOP) when a retry lands while UNCONFIRMED", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "UNCONFIRMED" }) });

    const result = await prepareUploadCommand(TABLE, baseInput, "token-x", mintS3Key);

    expect(result).toEqual({ action: "NOOP" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("returns RESOLVE_IMMEDIATELY without touching the table when already RESOLVED", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({
      Item: existingRecord({ status: "RESOLVED", resolvedOutcomeType: "UPLOADED" }),
    });

    const result = await prepareUploadCommand(TABLE, baseInput, "token-late", mintS3Key);

    expect(result).toEqual({ action: "RESOLVE_IMMEDIATELY", outcomeType: "UPLOADED", reason: undefined });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("throws on an internal reason/captureMode inconsistency instead of silently republishing", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({
      Item: existingRecord({ reason: "SENSOR_ANOMALY", captureMode: "CURRENT" }),
    });

    await expect(prepareUploadCommand(TABLE, baseInput, "token-x", mintS3Key)).rejects.toThrow(
      /Inconsistencia interna/,
    );
  });

  it("loses the race to acquire the lease between its own read and update: returns NOOP", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: existingRecord({ status: "PENDING" }) });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "raced", $metadata: {} }));

    const result = await prepareUploadCommand(TABLE, baseInput, "token-x", mintS3Key);

    expect(result).toEqual({ action: "NOOP" });
  });
});

describe("markAckAccepted", () => {
  it("advances PENDING -> ACK_ACCEPTED", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(markAckAccepted(TABLE, "case-1", "cmd-1")).resolves.toBe(true);
  });

  it("treats a duplicate ACK (no longer PENDING) as an idempotent no-op", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "dup", $metadata: {} }));
    await expect(markAckAccepted(TABLE, "case-1", "cmd-1")).resolves.toBe(false);
  });
});

describe("resolution lease (owner-scoped, ABA-safe)", () => {
  it("acquires a lease and returns the stored taskToken", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: existingRecord({ taskToken: "the-token" }) });
    const lease = await acquireResolutionLease(TABLE, "case-1", "cmd-1", 30);
    expect(lease?.taskToken).toBe("the-token");
  });

  it("returns undefined when contended or already resolved", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "contended", $metadata: {} }));
    await expect(acquireResolutionLease(TABLE, "case-1", "cmd-1", 30)).resolves.toBeUndefined();
  });

  it("finalizeResolved is a no-op (does not throw) when a newer worker already holds a different lease", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "stale lease", $metadata: {} }));
    await expect(
      finalizeResolved(TABLE, "case-1", { leaseId: "old-lease", taskToken: "t" }, "UPLOADED"),
    ).resolves.toBeUndefined();
  });

  it("releaseLeaseAsUnconfirmed is a no-op (does not throw) when a newer worker already holds a different lease", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "stale lease", $metadata: {} }));
    await expect(
      releaseLeaseAsUnconfirmed(TABLE, "case-1", { leaseId: "old-lease", taskToken: "t" }),
    ).resolves.toBeUndefined();
  });
});

describe("reconcileAfterWorkflowOutcome", () => {
  it("marks RESOLVED unconditionally (no lease/status gating) when the record exists", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(
      reconcileAfterWorkflowOutcome(TABLE, "case-1", "TIMEOUT", "States.Timeout"),
    ).resolves.toBeUndefined();
    const call = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(call?.ConditionExpression).toBe("attribute_exists(caseId)");
  });

  it("silently no-ops when there is no callback record (e.g. SKIPPED_NO_CONSENT path)", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "missing", $metadata: {} }));
    await expect(reconcileAfterWorkflowOutcome(TABLE, "case-1", "TIMEOUT")).resolves.toBeUndefined();
  });
});
