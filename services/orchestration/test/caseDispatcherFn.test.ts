import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { EventBridgeEvent } from "aws-lambda";
import { handler } from "../src/caseDispatcherFn.js";
import { config } from "../src/dispatcherConfig.js";

const sfnMock = mockClient(SFNClient);

const validDetail = {
  caseId: "44444444-4444-4444-b444-444444444444",
  deviceId: "pi-demo-01",
  recipientId: "recipient-demo-01",
  eventId: "22222222-2222-4222-9222-222222222222",
  eventType: "VISUAL_ANOMALY",
  anomalyType: "PERSON_PRONE_INACTIVE",
  occurredAt: "2026-09-23T18:30:00Z",
};

function eventFor(detail: unknown): EventBridgeEvent<"anomaly.detected", unknown> {
  return {
    id: "evt-1",
    version: "0",
    account: "123456789012",
    time: "2026-09-23T18:30:05Z",
    region: "us-east-1",
    resources: [],
    source: "SenseCare",
    "detail-type": "anomaly.detected",
    detail,
  };
}

beforeEach(() => {
  sfnMock.reset();
});

describe("caseDispatcherFn", () => {
  it("starts an execution named exactly with caseId", async () => {
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: "arn:...", startDate: new Date() });

    await handler(eventFor(validDetail));

    const calls = sfnMock.commandCalls(StartExecutionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.name).toBe(validDetail.caseId);
    expect(calls[0]?.args[0].input.stateMachineArn).toBe(config.stateMachineArn);
    expect(JSON.parse(String(calls[0]?.args[0].input.input))).toEqual(validDetail);
  });

  it("absorbs ExecutionAlreadyExistsException as an idempotent no-op", async () => {
    sfnMock
      .on(StartExecutionCommand)
      .rejects(new ExecutionAlreadyExists({ message: "exists", $metadata: {} }));

    await expect(handler(eventFor(validDetail))).resolves.toBeUndefined();
  });

  it("rethrows any other Step Functions error (so EventBridge retries/DLQs)", async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error("boom"));

    await expect(handler(eventFor(validDetail))).rejects.toThrow("boom");
  });

  it("rejects an invalid detail before calling StartExecution", async () => {
    const invalid = { ...validDetail, anomalyType: "NOT_A_REAL_TYPE" };

    await expect(handler(eventFor(invalid))).rejects.toThrow();

    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("rejects a detail with an unexpected extra field (e.g. executionArn) before calling StartExecution", async () => {
    const tampered = { ...validDetail, executionArn: "arn:aws:states:..." };

    await expect(handler(eventFor(tampered))).rejects.toThrow();

    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });
});
