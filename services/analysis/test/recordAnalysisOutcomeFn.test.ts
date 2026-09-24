import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/recordAnalysisOutcomeFn.js";
import type { RecordAnalysisOutcomeInput } from "../src/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

const CASE_ID = "55555555-5555-4555-8555-555555555555";
const IMAGE_ID = "66666666-6666-4666-9666-666666666666";
const S3_KEY = `raw-images/recipient-demo-01/${CASE_ID}/${IMAGE_ID}.jpg`;

const observation = {
  personDetected: true,
  posture: "lying_or_fallen" as const,
  riskIndicators: ["POSSIBLE_FALL" as const],
  needsHumanReview: true,
  confidence: 0.72,
  summary: "Persona en el suelo, sin movimiento aparente.",
};

const baseCaseDetail = {
  caseId: CASE_ID,
  deviceId: "pi-demo-01",
  recipientId: "recipient-demo-01",
  eventId: "22222222-2222-4222-9222-222222222222",
  eventType: "VISUAL_ANOMALY" as const,
  anomalyType: "PERSON_PRONE_INACTIVE" as const,
  occurredAt: "2026-09-24T18:30:00Z",
};

const completedInput: RecordAnalysisOutcomeInput = {
  caseDetail: baseCaseDetail,
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
  evidenceS3Key: S3_KEY,
  evidenceImageId: IMAGE_ID,
  analysisStatus: "COMPLETED",
  observation,
  failureReason: null,
};

const uncertainInput: RecordAnalysisOutcomeInput = {
  caseDetail: baseCaseDetail,
  executionArn: completedInput.executionArn,
  evidenceS3Key: S3_KEY,
  evidenceImageId: IMAGE_ID,
  analysisStatus: "UNCERTAIN",
  observation: null,
  failureReason: "MODEL_UNAVAILABLE",
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

describe("recordAnalysisOutcomeFn", () => {
  it("COMPLETED writes Observations with all fields, updates AnomalyCases with a safe excerpt, never touches status", async () => {
    await handler(completedInput);

    const observationItem = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-Observations-test")?.args[0].input.Item;
    expect(observationItem).toMatchObject({
      caseId: CASE_ID,
      imageId: IMAGE_ID,
      recipientId: "recipient-demo-01",
      s3Key: S3_KEY,
      personDetected: true,
      posture: "lying_or_fallen",
      riskIndicators: ["POSSIBLE_FALL"],
      needsHumanReview: true,
      confidence: 0.72,
      summary: observation.summary,
      modelId: "us.amazon.nova-lite-v1:0",
    });
    expect(observationItem?.ttlEpochSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const casesUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-AnomalyCases-test")?.args[0].input;
    expect(casesUpdate?.UpdateExpression).not.toContain(" status ");
    expect(casesUpdate?.UpdateExpression).not.toMatch(/\bSET\s+status\b/);
    expect(casesUpdate?.ExpressionAttributeValues?.[":status"]).toBe("COMPLETED");
    expect(casesUpdate?.ExpressionAttributeValues?.[":riskIndicators"]).toEqual(["POSSIBLE_FALL"]);

    const eventLogItem = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EventLog-test")?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("ANALYSIS_COMPLETED");
    expect(eventLogItem?.summary).toBeUndefined();
  });

  it("UNCERTAIN never writes to Observations, updates AnomalyCases.analysisFailureReason, logs ANALYSIS_UNCERTAIN", async () => {
    await handler(uncertainInput);

    const observationsCalls = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === "SenseCare-Observations-test");
    expect(observationsCalls).toHaveLength(0);

    const casesUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-AnomalyCases-test")?.args[0].input;
    expect(casesUpdate?.ExpressionAttributeValues?.[":status"]).toBe("UNCERTAIN");
    expect(casesUpdate?.ExpressionAttributeValues?.[":reason"]).toBe("MODEL_UNAVAILABLE");

    const eventLogItem = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "SenseCare-EventLog-test")?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("ANALYSIS_UNCERTAIN");
    expect(eventLogItem?.failureReason).toBe("MODEL_UNAVAILABLE");
  });

  it("is idempotent under redelivery: two invocations with the identical COMPLETED result target the same Observations key, never a duplicate row", async () => {
    await handler(completedInput);
    await handler(completedInput);

    const observationPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === "SenseCare-Observations-test");

    expect(observationPuts).toHaveLength(2);
    const keys = observationPuts.map((c) => ({
      caseId: c.args[0].input.Item?.caseId,
      imageId: c.args[0].input.Item?.imageId,
    }));
    expect(keys[0]).toEqual({ caseId: CASE_ID, imageId: IMAGE_ID });
    expect(keys[1]).toEqual({ caseId: CASE_ID, imageId: IMAGE_ID });
    // Misma llave (caseId+imageId) en ambos intentos: DynamoDB sobrescribe
    // la MISMA fila, nunca crea una segunda observacion COMPLETED distinta
    // para el mismo caseId+imageId.
    expect(keys[0]).toEqual(keys[1]);
  });
});
