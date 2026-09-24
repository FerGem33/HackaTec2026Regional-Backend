import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { handler } from "../src/requestHumanDecisionFn.js";
import { config } from "../src/requestHumanDecisionConfig.js";
import type { CaseTaskInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const input = {
  caseDetail: {
    caseId: "44444444-4444-4444-b444-444444444444",
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    eventId: "22222222-2222-4222-9222-222222222222",
    eventType: "SENSOR_ANOMALY",
    anomalyType: "TEMPERATURE_ALERT",
    occurredAt: "2026-09-23T18:30:00Z",
    severity: "critical",
  },
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
  taskToken: "token-xyz",
} satisfies CaseTaskInput & { taskToken: string };

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
});

describe("requestHumanDecisionFn", () => {
  it("resolves its own token immediately with SendTaskSuccess when CANCELLED already happened before the wait, and never touches CaseActionCallbacks", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { humanDecision: "CANCELLED", cancelledBy: "user-1" } });

    await handler(input);

    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    const call = sfnMock.commandCalls(SendTaskSuccessCommand)[0]?.args[0].input;
    expect(call?.taskToken).toBe("token-xyz");
    expect(JSON.parse(call?.output ?? "{}")).toEqual({ decision: "CANCELLED", resolvedBy: "user-1" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("resolves immediately for a pre-existing ESCALATED decision too, using escalatedBy", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { humanDecision: "ESCALATED", escalatedBy: "user-2" } });

    await handler(input);

    const call = sfnMock.commandCalls(SendTaskSuccessCommand)[0]?.args[0].input;
    expect(JSON.parse(call?.output ?? "{}")).toEqual({ decision: "ESCALATED", resolvedBy: "user-2" });
  });

  it("persists the taskToken as PENDING and never resolves when there is no prior decision", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler(input);

    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    const putCall = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(putCall?.TableName).toBe(config.caseActionCallbacksTableName);
    expect(putCall?.Item).toMatchObject({
      caseId: input.caseDetail.caseId,
      callbackType: "HUMAN_DECISION",
      taskToken: "token-xyz",
      status: "PENDING",
    });
    expect(putCall?.ConditionExpression).toBe("attribute_not_exists(caseId)");
  });
});
