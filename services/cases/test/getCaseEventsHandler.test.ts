import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/getCaseEventsHandler.js";

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

function requestFor(caseId: string, userId = "user-1", limit?: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { caseId },
    queryStringParameters: limit !== undefined ? { limit } : undefined,
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const CASE_ID = "44444444-4444-4444-b444-444444444444";

beforeEach(() => {
  ddbMock.reset();
  ddbMock
    .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
    .resolves({ Item: { caseId: CASE_ID, deviceId: "pi-demo-01", recipientId: "recipient-demo-01" } });
  ddbMock
    .on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME })
    .resolves({ Item: { userId: "user-1", deviceId: "pi-demo-01" } });
  ddbMock.on(QueryCommand).resolves({
    Items: [{ caseId: CASE_ID, occurredAtEventId: "2026-09-24T18:30:00Z#e1", eventType: "SENSOR_ANOMALY" }],
  });
});

describe("getCaseEventsHandler", () => {
  it("returns 200 with the EventLog timeline when the user is authorized", async () => {
    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.caseId).toBe(CASE_ID);
    expect(body.count).toBe(1);
  });

  it("returns 404 without querying EventLog when the case does not exist", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 403 without querying EventLog when the user never paired this device", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor(CASE_ID));

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    // El body de un 403 nunca debe filtrar datos del caso.
    const body = JSON.parse(result.body as string);
    expect(body).not.toHaveProperty("items");
  });

  it("returns 403 when the user is authorized for a different device entirely", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor(CASE_ID, "user-authorized-elsewhere"));

    expect(result.statusCode).toBe(403);
  });

  it("returns 400 for a non-positive-integer limit", async () => {
    const result = await callHandler(requestFor(CASE_ID, "user-1", "-1"));
    expect(result.statusCode).toBe(400);
  });
});
