import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { handler } from "../src/getDeviceTelemetryHandler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

function requestFor(
  deviceId: string,
  query: Record<string, string> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { deviceId },
    queryStringParameters: query,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [{ deviceId: "pi-demo-01", temperatureC: 27.3 }] });
});

describe("getDeviceTelemetryHandler", () => {
  it("returns 200 with the queried items for a plain request", async () => {
    const result = await handler(requestFor("pi-demo-01"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.deviceId).toBe("pi-demo-01");
    expect(body.count).toBe(1);
  });

  it("rejects a malformed from parameter with 400, without querying DynamoDB", async () => {
    const result = await handler(requestFor("pi-demo-01", { from: "not-a-date" }));

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects a non-integer limit with 400", async () => {
    const result = await handler(requestFor("pi-demo-01", { limit: "abc" }));

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects a zero or negative limit with 400", async () => {
    const result = await handler(requestFor("pi-demo-01", { limit: "0" }));

    expect(result.statusCode).toBe(400);
  });

  it("accepts a valid ISO-8601 from/to range", async () => {
    const result = await handler(
      requestFor("pi-demo-01", { from: "2026-09-24T00:00:00Z", to: "2026-09-24T23:59:59Z" }),
    );

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });
});
