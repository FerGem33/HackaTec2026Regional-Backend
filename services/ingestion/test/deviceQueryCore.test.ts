import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDeviceLatest, getTelemetryRange } from "../src/deviceQueryCore.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("getDeviceLatest", () => {
  it("combines Devices.lastSeenAt with the most recent Telemetry item", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { lastSeenAt: "2026-09-24T18:30:00Z" } });
    ddbMock.on(QueryCommand).resolves({
      Items: [{ deviceId: "pi-demo-01", temperatureC: 27.3, occurredAtEventId: "2026-09-24T18:30:00Z#e1" }],
    });

    const result = await getDeviceLatest("pi-demo-01");

    expect(result.lastSeenAt).toBe("2026-09-24T18:30:00Z");
    expect(result.latestTelemetry?.temperatureC).toBe(27.3);

    const queryCall = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(queryCall?.ScanIndexForward).toBe(false);
    expect(queryCall?.Limit).toBe(1);
  });

  it("returns nulls for a device that has never reported", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await getDeviceLatest("unknown-device");

    expect(result.lastSeenAt).toBeNull();
    expect(result.latestTelemetry).toBeNull();
  });
});

describe("getTelemetryRange", () => {
  it("caps limit at the maximum allowed (500) even if a larger value is requested", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getTelemetryRange({ deviceId: "pi-demo-01", limit: 10000 });

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.Limit).toBe(500);
  });

  it("defaults to 100 when no limit is given", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getTelemetryRange({ deviceId: "pi-demo-01" });

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.Limit).toBe(100);
  });

  it("builds a BETWEEN condition when both from and to are given, with to's suffix inclusive of same-instant events", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getTelemetryRange({ deviceId: "pi-demo-01", from: "2026-09-24T00:00:00Z", to: "2026-09-24T23:59:59Z" });

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.KeyConditionExpression).toContain("BETWEEN");
    expect(input?.ExpressionAttributeValues?.[":from"]).toBe("2026-09-24T00:00:00Z");
    expect(input?.ExpressionAttributeValues?.[":to"]).toBe("2026-09-24T23:59:59Z#￿");
  });

  it("queries only by deviceId when neither from nor to is given", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getTelemetryRange({ deviceId: "pi-demo-01" });

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.KeyConditionExpression).toBe("deviceId = :deviceId");
  });
});
