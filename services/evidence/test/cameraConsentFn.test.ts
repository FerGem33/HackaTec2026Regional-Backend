import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/cameraConsentFn.js";
import type { CaseTaskInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const input: CaseTaskInput = {
  caseDetail: {
    caseId: "case-1",
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    eventId: "22222222-2222-4222-9222-222222222222",
    eventType: "VISUAL_ANOMALY",
    anomalyType: "PERSON_PRONE_INACTIVE",
    occurredAt: "2026-09-24T18:30:00Z",
  },
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
};

beforeEach(() => {
  ddbMock.reset();
});

describe("cameraConsentFn", () => {
  it("returns true only when cameraConsent is strictly boolean true", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { deviceId: "pi-demo-01", cameraConsent: true } });
    await expect(handler(input)).resolves.toBe(true);
  });

  it.each([
    ["missing", {}],
    ["false", { cameraConsent: false }],
    ["string 'true'", { cameraConsent: "true" }],
    ["number 1", { cameraConsent: 1 }],
  ])("returns false when cameraConsent is %s", async (_label, item) => {
    ddbMock.on(GetCommand).resolves({ Item: { deviceId: "pi-demo-01", ...item } });
    await expect(handler(input)).resolves.toBe(false);
  });

  it("returns false when the device does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(handler(input)).resolves.toBe(false);
  });
});
