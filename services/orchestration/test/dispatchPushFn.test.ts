import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PinpointClient, SendMessagesCommand } from "@aws-sdk/client-pinpoint";
import { handler } from "../src/dispatchPushFn.js";
import { pushConfig } from "../src/pushConfig.js";
import type { CaseTaskInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const pinpointMock = mockClient(PinpointClient);

const input: CaseTaskInput = {
  caseDetail: {
    caseId: "44444444-4444-4444-b444-444444444444",
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    eventId: "22222222-2222-4222-9222-222222222222",
    eventType: "SENSOR_ANOMALY",
    anomalyType: "TEMPERATURE_ALERT",
    occurredAt: "2026-09-23T18:30:00Z",
    severity: "critical",
  },
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
};

function caregiverAccessQuery(): { TableName: string; IndexName: string } {
  return { TableName: pushConfig.caregiverAccessTableName, IndexName: "CaregiverAccessByDevice" };
}

function pushEndpointsQuery(): { TableName: string } {
  return { TableName: pushConfig.caregiverPushEndpointsTableName };
}

beforeEach(() => {
  ddbMock.reset();
  pinpointMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(QueryCommand, caregiverAccessQuery()).resolves({ Items: [{ userId: "user-1" }] });
  ddbMock
    .on(QueryCommand, pushEndpointsQuery())
    .resolves({ Items: [{ userId: "user-1", endpointId: "endpoint-1", status: "ACTIVE" }] });
  pinpointMock.on(SendMessagesCommand).resolves({
    MessageResponse: {
      ApplicationId: pushConfig.pinpointApplicationId,
      EndpointResult: { "endpoint-1": { DeliveryStatus: "SUCCESSFUL", StatusCode: 200 } },
    },
  });
});

describe("dispatchPushFn", () => {
  it("claims the case, resolves active endpoints and sends exactly one SendMessages call", async () => {
    await handler(input);

    const claimPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.Item?.deliveryId === "CLAIM");
    expect(claimPut?.args[0].input.ConditionExpression).toBe("attribute_not_exists(caseId)");

    expect(pinpointMock.commandCalls(SendMessagesCommand)).toHaveLength(1);
    const sendInput = pinpointMock.commandCalls(SendMessagesCommand)[0]?.args[0].input;
    expect(sendInput?.ApplicationId).toBe(pushConfig.pinpointApplicationId);
    expect(Object.keys(sendInput?.MessageRequest?.Endpoints ?? {})).toEqual(["endpoint-1"]);
  });

  it("sends a flat data-only RawContent payload with no recipientId, Bedrock summary, or S3 references", async () => {
    await handler(input);

    const sendInput = pinpointMock.commandCalls(SendMessagesCommand)[0]?.args[0].input;
    const rawContent = JSON.parse(sendInput?.MessageRequest?.MessageConfiguration?.GCMMessage?.RawContent ?? "{}");
    expect(rawContent.data).toMatchObject({
      type: "SENSECARE_ALERT",
      caseId: input.caseDetail.caseId,
      severity: "critical",
    });
    expect(rawContent.data).not.toHaveProperty("recipientId");
    expect(rawContent.data).not.toHaveProperty("s3Key");
    expect(rawContent.data).not.toHaveProperty("summary");
    expect(rawContent.data).not.toHaveProperty("imageUrl");
  });

  it("records a PUBLISHED delivery row for a SUCCESSFUL endpoint result", async () => {
    await handler(input);

    const deliveryPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.Item?.deliveryId === "PUSH#user-1#endpoint-1");
    expect(deliveryPut?.args[0].input.Item?.status).toBe("PUBLISHED");
  });

  it("records FAILED and disables the endpoint on PERMANENT_FAILURE, without throwing", async () => {
    pinpointMock.on(SendMessagesCommand).resolves({
      MessageResponse: {
        ApplicationId: pushConfig.pinpointApplicationId,
        EndpointResult: { "endpoint-1": { DeliveryStatus: "PERMANENT_FAILURE", StatusCode: 400 } },
      },
    });

    await expect(handler(input)).resolves.toEqual(input);

    const deliveryPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.Item?.deliveryId === "PUSH#user-1#endpoint-1");
    expect(deliveryPut?.args[0].input.Item?.status).toBe("FAILED");

    const disableUpdate = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(disableUpdate?.ExpressionAttributeValues?.[":disabled"]).toBe("DISABLED");
  });

  it("marks all endpoints FAILED and never throws when the whole SendMessages call fails", async () => {
    pinpointMock.on(SendMessagesCommand).rejects(new Error("Pinpoint unavailable"));

    await expect(handler(input)).resolves.toEqual(input);

    const deliveryPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.Item?.deliveryId === "PUSH#user-1#endpoint-1");
    expect(deliveryPut?.args[0].input.Item?.status).toBe("FAILED");
  });

  it("does nothing (no SendMessages call) when the caregiver has no ACTIVE endpoints", async () => {
    ddbMock.on(QueryCommand, pushEndpointsQuery()).resolves({ Items: [] });

    await handler(input);

    expect(pinpointMock.commandCalls(SendMessagesCommand)).toHaveLength(0);
  });

  it("does not dispatch a second time when the case is already claimed (dedup by conditional PutItem)", async () => {
    ddbMock.on(PutCommand).callsFake((putInput: { Item?: { deliveryId?: string } }) => {
      if (putInput.Item?.deliveryId === "CLAIM") {
        throw new ConditionalCheckFailedException({ message: "exists", $metadata: {} });
      }
      return {};
    });

    await handler(input);

    expect(pinpointMock.commandCalls(SendMessagesCommand)).toHaveLength(0);
  });
});
