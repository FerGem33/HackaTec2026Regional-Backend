import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/cancelCaseHandler.js";

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

const CASE_ID = "44444444-4444-4444-b444-444444444444";

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({
    Item: {
      caseId: CASE_ID,
      deviceId: "pi-demo-01",
      recipientId: "recipient-demo-01",
      anomalyType: "TEMPERATURE_ALERT",
      eventType: "SENSOR_ANOMALY",
    },
  });
  ddbMock
    .on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME })
    .resolves({ Item: { userId: "user-1", deviceId: "pi-demo-01" } });
  ddbMock.on(PutCommand).resolves({}); // EventLog
});

describe("cancelCaseHandler", () => {
  it("returns 404 without writing anything when the case does not exist", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(404);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns 403 without writing anything when the user has no access to this device", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor(CASE_ID, "unauthorized-user"));

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const body = JSON.parse(result.body as string);
    expect(body).not.toHaveProperty("alertStatus");
  });

  it("applies CANCEL_ALERT and audits it in EventLog", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({ caseId: CASE_ID, alertStatus: "CANCELLED" });

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("CANCEL_ALERT_APPLIED");
    expect(auditPut?.Item?.userId).toBe("user-1");
  });

  it("repeating the same cancel is idempotent (200, audited as NOOP)", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [] }));
    ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME, ConsistentRead: true }).resolves({
      Item: { caseId: CASE_ID, alertStatus: "CANCELLED" },
    });

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.alertStatus).toBe("CANCELLED");

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("CANCEL_ALERT_NOOP");
  });

  it("a cancel that loses the race against a prior escalate returns 409 with the real state, audited as REJECTED", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [] }));
    ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME, ConsistentRead: true }).resolves({
      Item: { caseId: CASE_ID, alertStatus: "ESCALATED" },
    });

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body as string);
    expect(body.alertStatus).toBe("ESCALATED");

    const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(auditPut?.Item?.eventType).toBe("CANCEL_ALERT_REJECTED");
  });
});
