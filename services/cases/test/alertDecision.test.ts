import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { applyAlertDecision } from "../src/alertDecision.js";
import { casesConfig } from "../src/casesConfig.js";
import type { CaseRecord } from "../src/caseAccess.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const caseRecord: CaseRecord = {
  caseId: "44444444-4444-4444-b444-444444444444",
  deviceId: "pi-demo-01",
  recipientId: "recipient-demo-01",
  anomalyType: "TEMPERATURE_ALERT",
  eventType: "SENSOR_ANOMALY",
};

beforeEach(() => {
  ddbMock.reset();
});

describe("applyAlertDecision", () => {
  it("applies CANCELLED atomically to both AnomalyCases and Alerts", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({ outcome: "APPLIED", alertStatus: "CANCELLED" });
    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const [casesUpdate, alertsUpdate] = transactInput?.TransactItems ?? [];
    expect(casesUpdate?.Update?.TableName).toBe(casesConfig.anomalyCasesTableName);
    expect(casesUpdate?.Update?.ExpressionAttributeValues?.[":userId"]).toBe("user-1");
    expect(alertsUpdate?.Update?.TableName).toBe(casesConfig.alertsTableName);
    // El backfill if_not_exists cubre el caso de una Alerts inexistente
    // todavia (ver docstring del modulo).
    expect(alertsUpdate?.Update?.UpdateExpression).toContain("if_not_exists(recipientId");
  });

  it("returns NOOP (idempotent) when the same decision was already applied", async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [] }),
    );
    ddbMock.on(GetCommand).resolves({ Item: { caseId: caseRecord.caseId, alertStatus: "CANCELLED" } });

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({ outcome: "NOOP", alertStatus: "CANCELLED" });
  });

  it("returns CONFLICT with the real current status when the opposite decision already won", async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [] }),
    );
    ddbMock.on(GetCommand).resolves({ Item: { caseId: caseRecord.caseId, alertStatus: "ESCALATED" } });

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({ outcome: "CONFLICT", alertStatus: "ESCALATED" });
  });

  it("propagates a non-cancellation error from the transaction", async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error("throttled"));

    await expect(applyAlertDecision(caseRecord, "ESCALATED", "user-1")).rejects.toThrow("throttled");
  });
});
