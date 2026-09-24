import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PinpointClient, UpdateEndpointCommand } from "@aws-sdk/client-pinpoint";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/registerPushDeviceHandler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const pinpointMock = mockClient(PinpointClient);

async function callHandler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawResult = await handler(event);
  if (typeof rawResult === "string") {
    throw new Error("expected a structured API Gateway result");
  }
  return rawResult;
}

function requestFor(body: unknown, userId = "user-1"): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  pinpointMock.reset();
  pinpointMock.on(UpdateEndpointCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

describe("registerPushDeviceHandler", () => {
  it("returns 401 without touching Pinpoint/DynamoDB when the JWT has no sub", async () => {
    const event = requestFor({ platform: "android", token: "tok-1" });
    // @ts-expect-error -- forzar sub ausente
    event.requestContext.authorizer.jwt.claims.sub = undefined;

    const result = await callHandler(event);

    expect(result.statusCode).toBe(401);
    expect(pinpointMock.commandCalls(UpdateEndpointCommand)).toHaveLength(0);
  });

  it("400s on an unsupported platform", async () => {
    const result = await callHandler(requestFor({ platform: "ios", token: "tok-1" }));
    expect(result.statusCode).toBe(400);
  });

  it("400s on a missing/empty token", async () => {
    const result = await callHandler(requestFor({ platform: "android", token: "" }));
    expect(result.statusCode).toBe(400);
  });

  it("400s on an unparseable body", async () => {
    const event = requestFor({ platform: "android", token: "tok-1" });
    event.body = "{not json";
    const result = await callHandler(event);
    expect(result.statusCode).toBe(400);
  });

  it("registers the endpoint with Pinpoint and upserts the row, deriving userId ONLY from the JWT (never the body)", async () => {
    const result = await callHandler(
      requestFor({ platform: "android", token: "tok-1", userId: "someone-else" }, "user-1"),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.endpointId).toBeTruthy();

    const updateEndpointInput = pinpointMock.commandCalls(UpdateEndpointCommand)[0]?.args[0].input;
    expect(updateEndpointInput?.EndpointRequest?.Address).toBe("tok-1");
    expect(updateEndpointInput?.EndpointRequest?.User?.UserId).toBe("user-1");
    expect(updateEndpointInput?.EndpointRequest?.ChannelType).toBe("GCM");

    const ddbUpdate = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(ddbUpdate?.Key?.userId).toBe("user-1");
  });

  it("derives the SAME endpointId for the same (userId, token) pair, so re-registering never creates a duplicate row", async () => {
    const first = await callHandler(requestFor({ platform: "android", token: "tok-1" }));
    const second = await callHandler(requestFor({ platform: "android", token: "tok-1" }));

    const firstId = JSON.parse(first.body as string).endpointId;
    const secondId = JSON.parse(second.body as string).endpointId;
    expect(firstId).toBe(secondId);
  });

  it("derives a DIFFERENT endpointId for a different token from the same user", async () => {
    const first = await callHandler(requestFor({ platform: "android", token: "tok-1" }));
    const second = await callHandler(requestFor({ platform: "android", token: "tok-2" }));

    const firstId = JSON.parse(first.body as string).endpointId;
    const secondId = JSON.parse(second.body as string).endpointId;
    expect(firstId).not.toBe(secondId);
  });

  it("502s when Pinpoint fails to update the endpoint, without writing to DynamoDB", async () => {
    pinpointMock.on(UpdateEndpointCommand).rejects(new Error("boom"));

    const result = await callHandler(requestFor({ platform: "android", token: "tok-1" }));

    expect(result.statusCode).toBe(502);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
