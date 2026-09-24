import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/recordCallOutcomeFn.js";
import { config } from "../src/recordCallOutcomeConfig.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("recordCallOutcomeFn", () => {
  it("on CALLED, sets dialStatus=CALLED with the contactId and audits EMERGENCY_CALL_INITIATED", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler({ caseId: "case-1", dialResult: { outcome: "CALLED", contactId: "contact-1" } });

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.TableName).toBe(config.anomalyCasesTableName);
    expect(updateCall?.ExpressionAttributeValues?.[":called"]).toBe("CALLED");
    expect(updateCall?.ExpressionAttributeValues?.[":contactId"]).toBe("contact-1");

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("EMERGENCY_CALL_INITIATED");
    expect(auditPut?.Item?.contactId).toBe("contact-1");
  });

  it("on FAILED, sets dialStatus=FAILED with the closed error code and audits EMERGENCY_CALL_FAILED", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler({ caseId: "case-1", dialResult: { outcome: "FAILED", errorCode: "DIAL_FAILED" } });

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(updateCall?.ExpressionAttributeValues?.[":failed"]).toBe("FAILED");
    expect(updateCall?.ExpressionAttributeValues?.[":reason"]).toBe("DIAL_FAILED");

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("EMERGENCY_CALL_FAILED");
    expect(auditPut?.Item?.reason).toBe("DIAL_FAILED");
  });
});
