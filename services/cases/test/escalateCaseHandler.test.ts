import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/escalateCaseHandler.js";
import { casesConfig } from "../src/casesConfig.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

async function callHandler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawResult = await handler(event);
  if (typeof rawResult === "string") {
    throw new Error("expected a structured API Gateway result");
  }
  return rawResult;
}

function requestFor(caseId: string, userId = "user-1"): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { caseId },
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function cancelledTransaction() {
  return new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [] });
}

const CASE_ID = "44444444-4444-4444-b444-444444444444";

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({
    Item: {
      caseId: CASE_ID,
      deviceId: "pi-demo-01",
      recipientId: "recipient-demo-01",
      anomalyType: "POSSIBLE_FALL",
      eventType: "VISUAL_ANOMALY",
    },
  });
  ddbMock
    .on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME })
    .resolves({ Item: { userId: "user-1", deviceId: "pi-demo-01" } });
  ddbMock.on(GetCommand, { TableName: casesConfig.caseActionCallbacksTableName }).resolves({});
  ddbMock.on(PutCommand).resolves({});
});

describe("escalateCaseHandler", () => {
  it("returns 403 for a user authorized on a different device", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor(CASE_ID, "user-on-another-device"));

    expect(result.statusCode).toBe(403);
  });

  it("applies ESCALATE, audits it, and never changes AnomalyCases.status (only humanDecision)", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({ caseId: CASE_ID, humanDecision: "ESCALATED" });

    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const casesUpdate = transactInput?.TransactItems?.[0]?.Update;
    expect(casesUpdate?.UpdateExpression).not.toContain(" status =");
    expect(casesUpdate?.UpdateExpression).toContain("humanDecision = :decision");

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("ESCALATE_APPLIED");
  });

  it("repeating the same escalate is idempotent (200, audited as NOOP)", async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction());
    ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME, ConsistentRead: true }).resolves({
      Item: { caseId: CASE_ID, humanDecision: "ESCALATED" },
    });

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(200);
    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("ESCALATE_NOOP");
  });

  it("an escalate attempted after the call already completed (CALLED) returns 409, audited as REJECTED", async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction());
    ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME, ConsistentRead: true }).resolves({
      Item: { caseId: CASE_ID, dialStatus: "CALLED" },
    });

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body as string);
    expect(body.conflictReason).toBe("CALL_ALREADY_IN_PROGRESS");
    expect(body.error).toContain("completó");

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("ESCALATE_REJECTED");
  });
});
