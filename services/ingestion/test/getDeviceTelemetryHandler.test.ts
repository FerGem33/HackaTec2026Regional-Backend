import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/getDeviceTelemetryHandler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

// jsonResponse() en el handler siempre retorna la forma estructurada, pero
// su firma declara el tipo union APIGatewayProxyResultV2 (que tambien
// admite `string`); este helper estrecha el tipo para los tests sin tocar
// el comportamiento en runtime.
async function callHandler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawResult = await handler(event);
  if (typeof rawResult === "string") {
    throw new Error("expected a structured API Gateway result");
  }
  return rawResult;
}

function requestFor(
  deviceId: string,
  query: Record<string, string> = {},
  userId = "user-1",
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { deviceId },
    queryStringParameters: query,
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  // Emparejamiento otorgado por defecto (GetCommand cubre tanto
  // CaregiverAccess como cualquier otra lectura puntual); los tests de 403
  // lo sobreescriben.
  ddbMock.on(GetCommand).resolves({ Item: { userId: "user-1", deviceId: "pi-demo-01" } });
  ddbMock.on(QueryCommand).resolves({ Items: [{ deviceId: "pi-demo-01", temperatureC: 27.3 }] });
});

describe("getDeviceTelemetryHandler", () => {
  it("returns 200 with the queried items when the device is already paired", async () => {
    const result = await callHandler(requestFor("pi-demo-01"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.deviceId).toBe("pi-demo-01");
    expect(body.count).toBe(1);
  });

  it("returns 403 and never queries Telemetry when the user has not paired this device", async () => {
    ddbMock.on(GetCommand).resolves({}); // sin fila en CaregiverAccess

    const result = await callHandler(requestFor("pi-demo-01"));

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects a malformed from parameter with 400, without querying DynamoDB", async () => {
    const result = await callHandler(requestFor("pi-demo-01", { from: "not-a-date" }));

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects a non-integer limit with 400", async () => {
    const result = await callHandler(requestFor("pi-demo-01", { limit: "abc" }));

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects a zero or negative limit with 400", async () => {
    const result = await callHandler(requestFor("pi-demo-01", { limit: "0" }));

    expect(result.statusCode).toBe(400);
  });

  it("accepts a valid ISO-8601 from/to range", async () => {
    const result = await callHandler(
      requestFor("pi-demo-01", { from: "2026-09-24T00:00:00Z", to: "2026-09-24T23:59:59Z" }),
    );

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });
});
