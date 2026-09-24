import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { resolveRecipientId, touchDeviceLastSeen } from "../src/devices.js";
import { DeviceNotFoundError } from "../src/errors.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("resolveRecipientId", () => {
  it("returns recipientId from the Devices table", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { deviceId: "pi-demo-01", recipientId: "recipient-demo-01" } });

    await expect(resolveRecipientId("pi-demo-01")).resolves.toBe("recipient-demo-01");
  });

  it("throws DeviceNotFoundError when the device does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});

    await expect(resolveRecipientId("pi-unknown")).rejects.toBeInstanceOf(DeviceNotFoundError);
  });
});

describe("touchDeviceLastSeen", () => {
  it("sends a conditional update guarding against out-of-order telemetry", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await touchDeviceLastSeen("pi-demo-01", "2026-09-23T18:30:00Z", "event-1");

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("swallows a conditional check failure (stale/out-of-order message)", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "stale", $metadata: {} }));

    await expect(
      touchDeviceLastSeen("pi-demo-01", "2026-09-23T18:30:00Z", "event-1"),
    ).resolves.toBeUndefined();
  });
});
