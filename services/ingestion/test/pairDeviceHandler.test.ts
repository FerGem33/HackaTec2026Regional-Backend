import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { handler } from "../src/pairDeviceHandler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

function requestFor(
  deviceId: string,
  body: unknown,
  userId: string | null = "user-1",
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { deviceId },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: { jwt: { claims: userId !== null ? { sub: userId } : {} } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: { pairingCode: "AB12CD" } });
  ddbMock.on(PutCommand).resolves({});
});

describe("pairDeviceHandler", () => {
  it("grants access and returns 200 when the pairing code matches", async () => {
    const result = await handler(requestFor("pi-demo-01", { pairingCode: "AB12CD" }));

    expect(result.statusCode).toBe(200);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.args[0].input.Item).toMatchObject({ userId: "user-1", deviceId: "pi-demo-01" });
  });

  it("accepts a pairing code regardless of case or surrounding whitespace", async () => {
    const result = await handler(requestFor("pi-demo-01", { pairingCode: " ab12cd " }));

    expect(result.statusCode).toBe(200);
  });

  it("returns 403 and grants nothing when the pairing code is wrong", async () => {
    const result = await handler(requestFor("pi-demo-01", { pairingCode: "WRONG1" }));

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns 404 when the device does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(requestFor("unknown-device", { pairingCode: "AB12CD" }));

    expect(result.statusCode).toBe(404);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns 400 when pairingCode is missing from the body", async () => {
    const result = await handler(requestFor("pi-demo-01", {}));

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns 400 on malformed JSON", async () => {
    const event = {
      pathParameters: { deviceId: "pi-demo-01" },
      body: "{not json",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it("returns 401 when the JWT has no sub claim", async () => {
    const result = await handler(requestFor("pi-demo-01", { pairingCode: "AB12CD" }, null));

    expect(result.statusCode).toBe(401);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
