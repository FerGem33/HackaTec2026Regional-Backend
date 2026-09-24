import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { handler } from "../src/renewOpenCaseLockFn.js";
import { config } from "../src/taskConfig.js";
import type { CaseTaskInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const input: CaseTaskInput = {
  caseDetail: {
    caseId: "44444444-4444-4444-b444-444444444444",
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    eventId: "22222222-2222-4222-9222-222222222222",
    eventType: "VISUAL_ANOMALY",
    anomalyType: "PERSON_PRONE_INACTIVE",
    occurredAt: "2026-09-23T18:30:00Z",
  },
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
};

beforeEach(() => {
  ddbMock.reset();
});

describe("renewOpenCaseLockFn", () => {
  it("renews the lock TTL conditioned on the lock still belonging to this caseId", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(input);

    const call = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(call?.TableName).toBe(config.openCaseLocksTableName);
    expect(call?.Key).toEqual({ lockKey: "recipient-demo-01#PERSON_PRONE_INACTIVE" });
    expect(call?.ConditionExpression).toBe("caseId = :caseId");
    expect(call?.ExpressionAttributeValues?.[":caseId"]).toBe(input.caseDetail.caseId);
    expect(result).toEqual(input);
  });

  it("does not throw when the lock now belongs to a different caseId; continues safely", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "owned by another case", $metadata: {} }));

    await expect(handler(input)).resolves.toEqual(input);
  });

  it("propagates any other DynamoDB error", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("transient"));

    await expect(handler(input)).rejects.toThrow("transient");
  });
});
