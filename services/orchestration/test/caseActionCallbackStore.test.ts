import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { prepareWaitForDecision, reconcileHumanDecisionCallback } from "../src/caseActionCallbackStore.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = "SenseCare-CaseActionCallbacks-test";

beforeEach(() => {
  ddbMock.reset();
});

describe("prepareWaitForDecision", () => {
  it("creates a new PENDING row on the first call", async () => {
    ddbMock.on(PutCommand).resolves({});

    await prepareWaitForDecision(TABLE, "case-1", "token-a", 3600);

    const putCall = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(putCall?.Item).toMatchObject({ caseId: "case-1", callbackType: "HUMAN_DECISION", taskToken: "token-a", status: "PENDING" });
    expect(putCall?.ConditionExpression).toBe("attribute_not_exists(caseId)");
  });

  it("refreshes the taskToken when the row already exists and is still PENDING (Step Functions retried the Task)", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(UpdateCommand).resolves({});

    await prepareWaitForDecision(TABLE, "case-1", "token-b", 3600);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.ExpressionAttributeValues?.[":token"]).toBe("token-b");
    expect(updateCall?.ConditionExpression).toBe("#status = :pending");
  });

  it("does nothing when the row already moved past PENDING (RESOLVING/RESOLVED/UNCONFIRMED)", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "not pending", $metadata: {} }));

    await expect(prepareWaitForDecision(TABLE, "case-1", "token-c", 3600)).resolves.toBeUndefined();
  });
});

describe("reconcileHumanDecisionCallback", () => {
  it("marks an existing row RESOLVED unconditionally", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await reconcileHumanDecisionCallback(TABLE, "case-1");

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.ExpressionAttributeValues?.[":resolved"]).toBe("RESOLVED");
    expect(updateCall?.ConditionExpression).toBe("attribute_exists(caseId)");
  });

  it("is a safe no-op when no row was ever created (requestHumanDecisionFn resolved immediately)", async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "missing", $metadata: {} }));

    await expect(reconcileHumanDecisionCallback(TABLE, "case-1")).resolves.toBeUndefined();
  });
});
