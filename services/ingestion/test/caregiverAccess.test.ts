import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { grantDeviceAccess, hasDeviceAccess } from "../src/caregiverAccess.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("hasDeviceAccess", () => {
  it("returns true when a CaregiverAccess row exists, using a strongly consistent read", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { userId: "user-1", deviceId: "pi-demo-01" } });

    expect(await hasDeviceAccess("user-1", "pi-demo-01")).toBe(true);
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });

  it("returns false when no row exists", async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await hasDeviceAccess("user-1", "pi-demo-01")).toBe(false);
  });
});

describe("grantDeviceAccess", () => {
  it("writes a CaregiverAccess row with a pairedAt timestamp", async () => {
    ddbMock.on(PutCommand).resolves({});

    await grantDeviceAccess("user-1", "pi-demo-01");

    const call = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(call?.Item).toMatchObject({ userId: "user-1", deviceId: "pi-demo-01" });
    expect(typeof call?.Item?.pairedAt).toBe("string");
  });
});
