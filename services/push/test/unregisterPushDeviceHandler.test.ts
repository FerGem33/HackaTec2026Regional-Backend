import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { PinpointClient, DeleteEndpointCommand, NotFoundException } from "@aws-sdk/client-pinpoint";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../src/unregisterPushDeviceHandler.js";

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

function requestFor(endpointId: string, userId = "user-1"): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { endpointId },
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  pinpointMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: { userId: "user-1", endpointId: "endpoint-1" } });
  pinpointMock.on(DeleteEndpointCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe("unregisterPushDeviceHandler", () => {
  it("returns 404 without calling Pinpoint when the endpoint does not belong to this user", async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await callHandler(requestFor("endpoint-1", "someone-else"));

    expect(result.statusCode).toBe(404);
    expect(pinpointMock.commandCalls(DeleteEndpointCommand)).toHaveLength(0);
  });

  it("deletes the Pinpoint endpoint and the row on success", async () => {
    const result = await callHandler(requestFor("endpoint-1"));

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    const deleteInput = ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input;
    expect(deleteInput?.Key).toEqual({ userId: "user-1", endpointId: "endpoint-1" });
  });

  it("still deletes the local row when Pinpoint already forgot the endpoint (NotFoundException)", async () => {
    pinpointMock
      .on(DeleteEndpointCommand)
      .rejects(new NotFoundException({ message: "Endpoint does not exist", $metadata: {} }));

    const result = await callHandler(requestFor("endpoint-1"));

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("502s and keeps the row when Pinpoint fails for a reason other than NotFound", async () => {
    pinpointMock.on(DeleteEndpointCommand).rejects(new Error("boom"));

    const result = await callHandler(requestFor("endpoint-1"));

    expect(result.statusCode).toBe(502);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });
});
