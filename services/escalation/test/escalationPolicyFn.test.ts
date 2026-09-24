import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { handler as HandlerType } from "../src/escalationPolicyFn.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const caseDetail = {
  caseId: "44444444-4444-4444-b444-444444444444",
  deviceId: "pi-demo-01",
  eventType: "SENSOR_ANOMALY" as const,
  anomalyType: "TEMPERATURE_ALERT",
  severity: "critical",
};

/**
 * escalationConfig.ts evalua HUMAN_NOTIFICATION_CHANNEL_CONFIRMED al
 * importarse (mismo patron eager que el resto de config.ts del monorepo,
 * ver env.ts en services/ingestion): para probar ambos valores en el mismo
 * archivo hace falta `vi.resetModules()` + import dinamico, igual que
 * services/ingestion/test/httpHandlersColdStart.test.ts.
 */
async function importHandlerWithChannelConfirmed(confirmed: boolean): Promise<typeof HandlerType> {
  const vitest = await import("vitest");
  vitest.vi.resetModules();
  process.env.HUMAN_NOTIFICATION_CHANNEL_CONFIRMED = confirmed ? "true" : "false";
  const module = await import("../src/escalationPolicyFn.js");
  return module.handler;
}

beforeEach(() => {
  ddbMock.reset();
});

describe("escalationPolicyFn", () => {
  it("blocks with NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL by default, even if every other condition would otherwise pass", async () => {
    const handler = await importHandlerWithChannelConfirmed(false);
    ddbMock
      .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
      .resolves({ Item: { notificationStatus: "PUBLISHED" } });
    ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: true } });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler({ caseDetail });

    expect(result).toEqual({ allowed: false, reason: "NO_ACTIVE_HUMAN_NOTIFICATION_CHANNEL" });
    const dialingClaim = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.ExpressionAttributeValues?.[":dialing"] === "DIALING");
    expect(dialingClaim).toBeUndefined();
  });

  describe("with a confirmed human notification channel", () => {
    let handler: typeof HandlerType;

    beforeAll(async () => {
      handler = await importHandlerWithChannelConfirmed(true);
    });

    it("blocks CASE_NOT_FOUND when the case does not exist", async () => {
      ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({ caseDetail });
      expect(result).toEqual({ allowed: false, reason: "CASE_NOT_FOUND" });
    });

    it("blocks CASE_CANCELLED when humanDecision is already CANCELLED", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { humanDecision: "CANCELLED" } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({ caseDetail });
      expect(result).toEqual({ allowed: false, reason: "CASE_CANCELLED" });
    });

    it("blocks NOTIFICATION_NOT_PUBLISHED when the SNS alert never actually published", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { notificationStatus: "FAILED" } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({ caseDetail });
      expect(result).toEqual({ allowed: false, reason: "NOTIFICATION_NOT_PUBLISHED" });
    });

    it("blocks RISK_NOT_ELIGIBLE for a non-critical sensor anomaly", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { notificationStatus: "PUBLISHED" } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({ caseDetail: { ...caseDetail, severity: "warning" } });
      expect(result).toEqual({ allowed: false, reason: "RISK_NOT_ELIGIBLE" });
    });

    it("blocks RISK_NOT_ELIGIBLE for UNEXPECTED_PERSON (excluded by default)", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { notificationStatus: "PUBLISHED" } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({
        caseDetail: {
          caseId: caseDetail.caseId,
          deviceId: caseDetail.deviceId,
          eventType: "VISUAL_ANOMALY",
          anomalyType: "UNEXPECTED_PERSON",
        },
      });
      expect(result).toEqual({ allowed: false, reason: "RISK_NOT_ELIGIBLE" });
    });

    it("allows POSSIBLE_FALL and PERSON_PRONE_INACTIVE visual anomalies through to the consent check", async () => {
      for (const anomalyType of ["POSSIBLE_FALL", "PERSON_PRONE_INACTIVE"]) {
        ddbMock.reset();
        ddbMock
          .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
          .resolves({ Item: { notificationStatus: "PUBLISHED" } });
        ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: true } });
        ddbMock.on(UpdateCommand).resolves({});

        const result = await handler({
          caseDetail: { caseId: caseDetail.caseId, deviceId: caseDetail.deviceId, eventType: "VISUAL_ANOMALY", anomalyType },
        });
        expect(result).toEqual({ allowed: true });
      }
    });

    it("blocks CONSENT_MISSING when fallbackCallConsent is not strictly boolean true", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { notificationStatus: "PUBLISHED" } });
      ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: "true" } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({ caseDetail });
      expect(result).toEqual({ allowed: false, reason: "CONSENT_MISSING" });
    });

    it("blocks DEVICE_NOT_ALLOWED for a device outside the escalation allowlist", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { notificationStatus: "PUBLISHED" } });
      ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: true } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler({ caseDetail: { ...caseDetail, deviceId: "unknown-device" } });
      expect(result).toEqual({ allowed: false, reason: "DEVICE_NOT_ALLOWED" });
    });

    it("allows and atomically claims dialStatus=DIALING (guarded against a concurrent CANCELLED) when every condition passes", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolves({ Item: { notificationStatus: "PUBLISHED" } });
      ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: true } });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler({ caseDetail });

      expect(result).toEqual({ allowed: true });
      const claimCall = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
      expect(claimCall?.ExpressionAttributeValues?.[":dialing"]).toBe("DIALING");
      expect(claimCall?.ConditionExpression).toContain("attribute_not_exists(dialStatus)");
      expect(claimCall?.ConditionExpression).toContain("humanDecision <> :cancelled");
    });

    it("never claims DIALING twice for the same caseId (ALREADY_DIALED)", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolvesOnce({ Item: { notificationStatus: "PUBLISHED" } })
        .resolves({ Item: { notificationStatus: "PUBLISHED", dialStatus: "DIALING" } });
      ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: true } });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "already dialing", $metadata: {} }));

      const result = await handler({ caseDetail });

      expect(result).toEqual({ allowed: false, reason: "ALREADY_DIALED" });
    });

    it("the DIALING claim race: a CANCEL_ALERT that wins first prevents the claim, reported as CASE_CANCELLED", async () => {
      ddbMock
        .on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME })
        .resolvesOnce({ Item: { notificationStatus: "PUBLISHED" } })
        .resolves({ Item: { notificationStatus: "PUBLISHED", humanDecision: "CANCELLED" } });
      ddbMock.on(GetCommand, { TableName: process.env.DEVICES_TABLE_NAME }).resolves({ Item: { fallbackCallConsent: true } });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "cancelled", $metadata: {} }));

      const result = await handler({ caseDetail });

      expect(result).toEqual({ allowed: false, reason: "CASE_CANCELLED" });
    });

    it("writes ESCALATED_BLOCKED to EventLog with the closed reason code for a blocked path", async () => {
      ddbMock.on(GetCommand, { TableName: process.env.ANOMALY_CASES_TABLE_NAME }).resolves({});
      ddbMock.on(PutCommand).resolves({});

      await handler({ caseDetail });

      const auditPut = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
      expect(auditPut?.Item?.eventType).toBe("ESCALATED_BLOCKED");
      expect(auditPut?.Item?.reason).toBe("CASE_NOT_FOUND");
    });
  });
});
