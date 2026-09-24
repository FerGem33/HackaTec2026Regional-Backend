import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { handler, type RecordEvidenceOutcomeInput } from "../src/recordEvidenceOutcomeFn.js";
import type { CaseTaskInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const CASE_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "22222222-2222-4222-9222-222222222222";

const baseCaseTask: CaseTaskInput = {
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
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe("recordEvidenceOutcomeFn", () => {
  it("UNCONFIRMED reconciled by a States.Timeout catch-chain resolves to INCOMPLETE (EvidenceCallbacks healed via reconcileAfterWorkflowOutcome)", async () => {
    ddbMock.on(UpdateCommand, { TableName: "SenseCare-AnomalyCases-test" }).resolves({});
    const reconcileCall = ddbMock.on(UpdateCommand, { TableName: "SenseCare-EvidenceCallbacks-test" }).resolves({});

    const input: RecordEvidenceOutcomeInput = {
      ...baseCaseTask,
      evidenceStatus: "INCOMPLETE",
      evidenceReason: "States.Timeout",
    };

    await handler(input);

    const reconcileUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EvidenceCallbacks-test");
    expect(reconcileUpdate?.args[0].input.ConditionExpression).toBe("attribute_exists(caseId)");
    expect(reconcileUpdate?.args[0].input.ExpressionAttributeValues?.[":outcomeType"]).toBe("TIMEOUT");

    const eventLogItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("EVIDENCE_INCOMPLETE");
    void reconcileCall;
  });

  it("UNCONFIRMED reconciled by a successful path resolves to AVAILABLE (EvidenceCallbacks marked UPLOADED)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const input: RecordEvidenceOutcomeInput = {
      ...baseCaseTask,
      evidenceStatus: "AVAILABLE",
      evidenceS3Key: "raw-images/recipient-demo-01/case/img.jpg",
      evidenceImageId: "img-id",
    };

    await handler(input);

    const reconcileUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EvidenceCallbacks-test");
    expect(reconcileUpdate?.args[0].input.ExpressionAttributeValues?.[":outcomeType"]).toBe("UPLOADED");

    const eventLogItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("EVIDENCE_AVAILABLE");
  });

  it("SKIPPED_NO_CONSENT never attempts to reconcile EvidenceCallbacks (no record was ever created for this case)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const input: RecordEvidenceOutcomeInput = { ...baseCaseTask, evidenceStatus: "SKIPPED_NO_CONSENT" };

    await handler(input);

    const reconcileUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EvidenceCallbacks-test");
    expect(reconcileUpdate).toBeUndefined();

    const eventLogItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("EVIDENCE_INCOMPLETE");
  });

  it("maps CommandRejected/EvidenceUploadFailed/EvidenceObjectMissing/EvidenceObjectInvalid to their resolved outcome types", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const cases: Array<[string, string]> = [
      ["CommandRejected", "REJECTED"],
      ["EvidenceUploadFailed", "UPLOAD_FAILED"],
      ["EvidenceObjectMissing", "OBJECT_MISSING"],
      ["EvidenceObjectInvalid", "OBJECT_INVALID"],
    ];

    for (const [evidenceReason, expectedOutcome] of cases) {
      ddbMock.resetHistory();
      await handler({ ...baseCaseTask, evidenceStatus: "INCOMPLETE", evidenceReason });
      const reconcileUpdate = ddbMock
        .commandCalls(UpdateCommand)
        .find((c) => c.args[0].input.TableName === "SenseCare-EvidenceCallbacks-test");
      expect(reconcileUpdate?.args[0].input.ExpressionAttributeValues?.[":outcomeType"]).toBe(expectedOutcome);
    }
  });

  it("reconciliation silently no-ops when no EvidenceCallbacks record exists for the case (already-consistent state)", async () => {
    ddbMock.on(UpdateCommand, { TableName: "SenseCare-AnomalyCases-test" }).resolves({});
    ddbMock
      .on(UpdateCommand, { TableName: "SenseCare-EvidenceCallbacks-test" })
      .rejects(new ConditionalCheckFailedException({ message: "missing", $metadata: {} }));

    const input: RecordEvidenceOutcomeInput = {
      ...baseCaseTask,
      evidenceStatus: "ERROR",
      evidenceReason: "SomeInternalError",
    };

    await expect(handler(input)).resolves.toEqual({
      caseDetail: baseCaseTask.caseDetail,
      executionArn: baseCaseTask.executionArn,
    });
  });
});
