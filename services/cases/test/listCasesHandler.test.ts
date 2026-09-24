import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/listCasesHandler.js";

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

function requestFor(userId = "user-1", limit?: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    queryStringParameters: limit !== undefined ? { limit } : null,
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
});

describe("listCasesHandler", () => {
  it("returns 401 without querying anything when the JWT has no sub", async () => {
    const event = requestFor();
    // @ts-expect-error -- forzar sub ausente
    event.requestContext.authorizer.jwt.claims.sub = undefined;

    const result = await callHandler(event);

    expect(result.statusCode).toBe(401);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns an empty list (200, not 403) when the user has no CaregiverAccess rows at all", async () => {
    ddbMock.on(QueryCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME }).resolves({ Items: [] });

    const result = await callHandler(requestFor());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ count: 0, items: [] });
    expect(ddbMock.commandCalls(QueryCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })).toHaveLength(0);
  });

  it("400s on a non-positive limit", async () => {
    const result = await callHandler(requestFor("user-1", "0"));
    expect(result.statusCode).toBe(400);
  });

  it("clamps an oversized limit to MAX_LIMIT (200) before querying", async () => {
    ddbMock
      .on(QueryCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME })
      .resolves({ Items: [{ deviceId: "pi-demo-01" }] });
    ddbMock.on(QueryCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({ Items: [] });

    await callHandler(requestFor("user-1", "999999"));

    const call = ddbMock
      .commandCalls(QueryCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })[0]
      ?.args[0].input as { Limit?: number };
    expect(call?.Limit).toBe(200);
  });

  it("merges and sorts cases from multiple authorized devices by createdAt desc", async () => {
    ddbMock
      .on(QueryCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME })
      .resolves({ Items: [{ deviceId: "pi-demo-01" }, { deviceId: "pi-demo-02" }] });
    ddbMock
      .on(QueryCommand, {
        TableName: process.env.ANOMALY_CASES_TABLE_NAME,
        IndexName: "AnomalyCasesByDevice",
        ExpressionAttributeValues: { ":deviceId": "pi-demo-01" },
      })
      .resolves({
        Items: [
          {
            caseId: "case-a",
            deviceId: "pi-demo-01",
            eventType: "SENSOR_ANOMALY",
            anomalyType: "TEMPERATURE_ALERT",
            createdAt: "2026-09-24T10:00:00.000Z",
          },
        ],
      });
    ddbMock
      .on(QueryCommand, {
        TableName: process.env.ANOMALY_CASES_TABLE_NAME,
        IndexName: "AnomalyCasesByDevice",
        ExpressionAttributeValues: { ":deviceId": "pi-demo-02" },
      })
      .resolves({
        Items: [
          {
            caseId: "case-b",
            deviceId: "pi-demo-02",
            eventType: "VISUAL_ANOMALY",
            anomalyType: "POSSIBLE_FALL",
            createdAt: "2026-09-24T11:00:00.000Z",
          },
        ],
      });

    const result = await callHandler(requestFor());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.count).toBe(2);
    expect(body.items.map((item: { caseId: string }) => item.caseId)).toEqual(["case-b", "case-a"]);
  });
});
