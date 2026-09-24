import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { handler } from "../src/dispatchAlertFn.js";
import { config } from "../src/alertConfig.js";
import type { CaseTaskInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);

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

beforeEach(() => {
  ddbMock.reset();
  snsMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [{ userId: "user-1" }, { userId: "user-2" }] });
  snsMock.on(PublishCommand).resolves({ MessageId: "sns-message-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchAlertFn", () => {
  it("queries CaregiverAccessByDevice for the case's deviceId and stores it as notifiedCaregiverIds", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await handler(input);

    const queryCall = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(queryCall?.TableName).toBe(config.caregiverAccessTableName);
    expect(queryCall?.IndexName).toBe("CaregiverAccessByDevice");
    expect(queryCall?.ExpressionAttributeValues?.[":deviceId"]).toBe("pi-demo-01");

    const putCall = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(putCall?.Item?.notifiedCaregiverIds).toEqual(["user-1", "user-2"]);
    expect(putCall?.Item?.notificationStatus).toBe("PENDING");
    expect(putCall?.ConditionExpression).toBe("attribute_not_exists(caseId)");
  });

  it("publishes exactly once and marks notificationStatus PUBLISHED with the SNS messageId (never humanDecision/dialStatus)", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await handler(input);

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    const publishInput = snsMock.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publishInput?.TopicArn).toBe(config.alertsTopicArn);
    const message = JSON.parse(publishInput?.Message ?? "{}");
    expect(message).toMatchObject({
      caseId: input.caseDetail.caseId,
      anomalyType: "TEMPERATURE_ALERT",
      severity: "critical",
    });
    // Nunca datos sensibles: sin recipientId, s3Key, summary ni imagenes.
    expect(message).not.toHaveProperty("recipientId");
    expect(message).not.toHaveProperty("s3Key");
    expect(message).not.toHaveProperty("summary");

    const publishedUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === config.alertsTableName);
    expect(publishedUpdate?.args[0].input.ExpressionAttributeValues?.[":published"]).toBe("PUBLISHED");
    expect(publishedUpdate?.args[0].input.ExpressionAttributeValues?.[":messageId"]).toBe("sns-message-1");

    const mirrorUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === config.anomalyCasesTableName);
    expect(mirrorUpdate?.args[0].input.ExpressionAttributeValues?.[":notificationStatus"]).toBe("PUBLISHED");
    // notificationStatus nunca debe tocar humanDecision/dialStatus.
    expect(mirrorUpdate?.args[0].input.UpdateExpression).not.toContain("humanDecision");
    expect(mirrorUpdate?.args[0].input.UpdateExpression).not.toContain("dialStatus");
  });

  it("does not publish a second time when the alert is already PUBLISHED (dedup by conditional PutItem)", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({
      Item: {
        caseId: input.caseDetail.caseId,
        notificationStatus: "PUBLISHED",
        createdAt: new Date().toISOString(),
      },
    });

    await handler(input);

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("does not re-publish for a fresh PENDING record (another invocation is likely mid-flight)", async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({
      Item: {
        caseId: input.caseDetail.caseId,
        notificationStatus: "PENDING",
        createdAt: new Date().toISOString(), // recien creado
      },
    });

    await handler(input);

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it("retakes a stale PENDING record and publishes (self-healing after a crashed winner)", async () => {
    const staleCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min de antiguedad
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddbMock.on(GetCommand).resolves({
      Item: { caseId: input.caseDetail.caseId, notificationStatus: "PENDING", createdAt: staleCreatedAt },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(input);

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    const reclaimUpdate = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(reclaimUpdate?.ConditionExpression).toBe("notificationStatus = :pending AND createdAt = :createdAt");
  });

  it("marks notificationStatus FAILED and never throws when SNS publish fails (case stays intact)", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    snsMock.on(PublishCommand).rejects(new Error("SNS unavailable"));

    await expect(handler(input)).resolves.toEqual(input);

    const failedUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === config.alertsTableName);
    expect(failedUpdate?.args[0].input.ExpressionAttributeValues?.[":failed"]).toBe("FAILED");

    const mirrorUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === config.anomalyCasesTableName);
    expect(mirrorUpdate?.args[0].input.ExpressionAttributeValues?.[":notificationStatus"]).toBe("FAILED");
  });

  it("omits severity from the SNS message for a VISUAL_ANOMALY case (no severity on the contract)", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const visualInput: CaseTaskInput = {
      ...input,
      caseDetail: { ...input.caseDetail, eventType: "VISUAL_ANOMALY", anomalyType: "POSSIBLE_FALL", severity: undefined },
    };

    await handler(visualInput);

    const publishInput = snsMock.commandCalls(PublishCommand)[0]?.args[0].input;
    const message = JSON.parse(publishInput?.Message ?? "{}");
    expect(message).not.toHaveProperty("severity");
  });
});
