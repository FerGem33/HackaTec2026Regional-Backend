import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { handler } from "../src/upsertAnomalyCaseFn.js";
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

describe("upsertAnomalyCaseFn", () => {
  it("creates a new AnomalyCases item with status DETECTED and this execution's ARN", async () => {
    ddbMock.on(PutCommand).resolves({});

    await handler(input);

    const putCall = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(putCall?.TableName).toBe(config.anomalyCasesTableName);
    expect(putCall?.ConditionExpression).toBe("attribute_not_exists(caseId)");
    expect(putCall?.Item).toMatchObject({
      caseId: input.caseDetail.caseId,
      status: "DETECTED",
      executionArn: input.executionArn,
      recipientId: "recipient-demo-01",
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("on a duplicate case, only updates updatedAt (never status/createdAt/executionArn)", async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(UpdateCommand).resolves({});

    await handler(input);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.TableName).toBe(config.anomalyCasesTableName);
    expect(updateCall?.Key).toEqual({ caseId: input.caseDetail.caseId });
    expect(updateCall?.UpdateExpression).toBe("SET updatedAt = :updatedAt");
    expect(updateCall?.UpdateExpression).not.toContain("status");
    expect(updateCall?.UpdateExpression).not.toContain("createdAt");
    expect(updateCall?.UpdateExpression).not.toContain("executionArn");
  });

  it("propagates any other DynamoDB error from the initial Put", async () => {
    ddbMock.on(PutCommand).rejects(new Error("transient"));

    await expect(handler(input)).rejects.toThrow("transient");
  });
});
