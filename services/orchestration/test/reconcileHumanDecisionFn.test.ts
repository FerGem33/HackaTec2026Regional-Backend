import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/reconcileHumanDecisionFn.js";
import { config } from "../src/reconcileHumanDecisionConfig.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("reconcileHumanDecisionFn", () => {
  it("reconciles the callback row and returns the input unchanged (resultPath: DISCARD in CDK)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const input = { caseDetail: { caseId: "case-1" }, executionArn: "arn:...", evidenceStatus: "AVAILABLE" };

    const result = await handler(input);

    expect(result).toBe(input);
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.TableName).toBe(config.caseActionCallbacksTableName);
    expect(updateCall?.Key).toEqual({ caseId: "case-1", callbackType: "HUMAN_DECISION" });
  });
});
