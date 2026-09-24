import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { SFNClient, SendTaskSuccessCommand, InvalidToken } from "@aws-sdk/client-sfn";
import { applyAlertDecision } from "../src/alertDecision.js";
import { casesConfig } from "../src/casesConfig.js";
import type { CaseRecord } from "../src/caseAccess.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const caseRecord: CaseRecord = {
  caseId: "44444444-4444-4444-b444-444444444444",
  deviceId: "pi-demo-01",
  recipientId: "recipient-demo-01",
  anomalyType: "TEMPERATURE_ALERT",
  eventType: "SENSOR_ANOMALY",
};

function cancelledTransaction() {
  return new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [] });
}

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  // Sin callback pendiente por defecto: la mayoria de los tests no tocan
  // el wait de Step Functions en absoluto.
  ddbMock
    .on(GetCommand, { TableName: casesConfig.caseActionCallbacksTableName })
    .resolves({});
});

describe("applyAlertDecision", () => {
  it("applies CANCELLED atomically to both AnomalyCases and Alerts, writing humanDecision (never notificationStatus/dialStatus)", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({ outcome: "APPLIED", humanDecision: "CANCELLED" });
    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const [casesUpdate, alertsUpdate] = transactInput?.TransactItems ?? [];
    expect(casesUpdate?.Update?.TableName).toBe(casesConfig.anomalyCasesTableName);
    expect(casesUpdate?.Update?.UpdateExpression).toContain("humanDecision = :decision");
    expect(casesUpdate?.Update?.UpdateExpression).not.toContain("notificationStatus");
    expect(casesUpdate?.Update?.ExpressionAttributeValues?.[":userId"]).toBe("user-1");
    expect(alertsUpdate?.Update?.TableName).toBe(casesConfig.alertsTableName);
    // El backfill if_not_exists cubre el caso de una Alerts inexistente
    // todavia (ver docstring del modulo).
    expect(alertsUpdate?.Update?.UpdateExpression).toContain("if_not_exists(recipientId");
    // Solo 2 items: sin callback pendiente, no se toca CaseActionCallbacks.
    expect(transactInput?.TransactItems).toHaveLength(2);
  });

  it("requires dialStatus to not already be DIALING/CALLED as part of the same atomic condition", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const casesUpdate = transactInput?.TransactItems?.[0]?.Update;
    expect(casesUpdate?.ConditionExpression).toContain("attribute_not_exists(humanDecision)");
    expect(casesUpdate?.ConditionExpression).toContain("dialStatus <> :dialing");
    expect(casesUpdate?.ConditionExpression).toContain("dialStatus <> :called");
  });

  it("returns NOOP (idempotent) when the same decision was already applied", async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction());
    ddbMock
      .on(GetCommand, { TableName: casesConfig.anomalyCasesTableName })
      .resolves({ Item: { caseId: caseRecord.caseId, humanDecision: "CANCELLED" } });

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({ outcome: "NOOP", humanDecision: "CANCELLED" });
  });

  it("returns CONFLICT (OPPOSITE_DECISION_ALREADY_APPLIED) when the opposite decision already won", async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction());
    ddbMock
      .on(GetCommand, { TableName: casesConfig.anomalyCasesTableName })
      .resolves({ Item: { caseId: caseRecord.caseId, humanDecision: "ESCALATED" } });

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({
      outcome: "CONFLICT",
      humanDecision: "ESCALATED",
      conflictReason: "OPPOSITE_DECISION_ALREADY_APPLIED",
    });
  });

  it("returns CONFLICT (CALL_ALREADY_IN_PROGRESS) and never claims to have cancelled a call already DIALING", async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction());
    ddbMock
      .on(GetCommand, { TableName: casesConfig.anomalyCasesTableName })
      .resolves({ Item: { caseId: caseRecord.caseId, dialStatus: "DIALING" } });

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result).toEqual({
      outcome: "CONFLICT",
      humanDecision: "UNDECIDED",
      dialStatus: "DIALING",
      conflictReason: "CALL_ALREADY_IN_PROGRESS",
    });
  });

  it("returns CONFLICT (CALL_ALREADY_IN_PROGRESS) for a call that already completed (CALLED)", async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction());
    ddbMock
      .on(GetCommand, { TableName: casesConfig.anomalyCasesTableName })
      .resolves({ Item: { caseId: caseRecord.caseId, dialStatus: "CALLED" } });

    const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

    expect(result.outcome).toBe("CONFLICT");
    expect(result.conflictReason).toBe("CALL_ALREADY_IN_PROGRESS");
  });

  it("propagates a non-cancellation error from the transaction", async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error("throttled"));

    await expect(applyAlertDecision(caseRecord, "ESCALATED", "user-1")).rejects.toThrow("throttled");
  });

  describe("resolving a pending Step Functions wait", () => {
    const pendingCallback = {
      caseId: caseRecord.caseId,
      callbackType: "HUMAN_DECISION",
      taskToken: "token-abc",
      status: "PENDING",
    };

    beforeEach(() => {
      ddbMock
        .on(GetCommand, { TableName: casesConfig.caseActionCallbacksTableName })
        .resolves({ Item: pendingCallback });
    });

    it("includes the callback as a 3rd transact item and resolves it via SendTaskSuccess after the transaction commits", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      sfnMock.on(SendTaskSuccessCommand).resolves({});

      const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

      expect(result).toEqual({ outcome: "APPLIED", humanDecision: "CANCELLED" });
      const transactInput = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
      expect(transactInput?.TransactItems).toHaveLength(3);
      const callbackUpdate = transactInput?.TransactItems?.[2]?.Update;
      expect(callbackUpdate?.TableName).toBe(casesConfig.caseActionCallbacksTableName);
      expect(callbackUpdate?.ConditionExpression).toBe("#status = :pending AND taskToken = :expectedToken");
      expect(callbackUpdate?.ExpressionAttributeValues?.[":expectedToken"]).toBe("token-abc");

      const sendTaskCall = sfnMock.commandCalls(SendTaskSuccessCommand)[0]?.args[0].input;
      expect(sendTaskCall?.taskToken).toBe("token-abc");
      expect(JSON.parse(sendTaskCall?.output ?? "{}")).toEqual({ decision: "CANCELLED", resolvedBy: "user-1" });

      const resolvedUpdate = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
      expect(resolvedUpdate?.ExpressionAttributeValues?.[":resolved"]).toBe("RESOLVED");
    });

    it("marks the callback UNCONFIRMED (not an error) when SendTaskSuccess reports an already-timed-out token", async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      sfnMock.on(SendTaskSuccessCommand).rejects(new InvalidToken({ message: "invalid", $metadata: {} }));

      const result = await applyAlertDecision(caseRecord, "ESCALATED", "user-1");

      // La decision sobre el caso ya se aplico de forma duradera, aunque
      // Step Functions ya no pueda enterarse por esta via.
      expect(result).toEqual({ outcome: "APPLIED", humanDecision: "ESCALATED" });
      const unconfirmedUpdate = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
      expect(unconfirmedUpdate?.ExpressionAttributeValues?.[":unconfirmed"]).toBe("UNCONFIRMED");
    });

    it("retries without the callback item when only the stale taskToken condition fails, and still applies the decision", async () => {
      ddbMock.on(TransactWriteCommand).rejectsOnce(cancelledTransaction()).resolves({});
      // Tras el fallo, se relee AnomalyCases: humanDecision sigue sin
      // definirse y dialStatus no bloquea -> se reintenta SOLO con 2 items.
      ddbMock
        .on(GetCommand, { TableName: casesConfig.anomalyCasesTableName })
        .resolves({ Item: { caseId: caseRecord.caseId } });

      const result = await applyAlertDecision(caseRecord, "CANCELLED", "user-1");

      expect(result).toEqual({ outcome: "APPLIED", humanDecision: "CANCELLED" });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
      const retryInput = ddbMock.commandCalls(TransactWriteCommand)[1]?.args[0].input;
      expect(retryInput?.TransactItems).toHaveLength(2); // sin el 3er item esta vez
      // El reintento sin callback nunca llama a SendTaskSuccess: el token
      // obsoleto se deja sin resolver a proposito (ver docstring del modulo).
      expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
    });
  });
});
