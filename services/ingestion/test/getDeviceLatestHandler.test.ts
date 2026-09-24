import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/getDeviceLatestHandler.js";

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

function requestFor(deviceId: string, userId = "user-1"): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { deviceId },
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  // Diferenciado por TableName: CaregiverAccess (autorizacion) vs Devices
  // (lastSeenAt). Sin este matching, un solo `.on(GetCommand)` generico no
  // podria distinguir "emparejado" de "sin lastSeenAt todavia".
  ddbMock
    .on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME })
    .resolves({ Item: { userId: "user-1", deviceId: "pi-demo-01" } });
  ddbMock
    .on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME })
    .resolves({ Item: { lastSeenAt: "2026-09-24T18:30:00Z" } });
  ddbMock.on(QueryCommand).resolves({
    Items: [{ deviceId: "pi-demo-01", temperatureC: 27.3, occurredAtEventId: "2026-09-24T18:30:00Z#e1" }],
  });
});

describe("getDeviceLatestHandler", () => {
  it("returns 200 with the latest reading when the device is already paired", async () => {
    const result = await callHandler(requestFor("pi-demo-01"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.lastSeenAt).toBe("2026-09-24T18:30:00Z");
    expect(body.latestTelemetry.temperatureC).toBe(27.3);
  });

  it("returns 403 and never touches Devices/Telemetry when the user has not paired this device", async () => {
    ddbMock.on(GetCommand, { TableName: process.env.CAREGIVER_ACCESS_TABLE_NAME }).resolves({});

    const result = await callHandler(requestFor("pi-demo-01"));

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 400 when deviceId is missing from the path", async () => {
    const event = { pathParameters: {} } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const result = await callHandler(event);

    expect(result.statusCode).toBe(400);
  });
});
