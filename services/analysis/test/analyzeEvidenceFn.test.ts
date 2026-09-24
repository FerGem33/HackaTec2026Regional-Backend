import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { HeadObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ThrottlingException,
  AccessDeniedException,
  ResourceNotFoundException,
  ValidationException,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { handler } from "../src/analyzeEvidenceFn.js";
import type { AnalyzeEvidenceInput } from "../src/types.js";

const s3Mock = mockClient(S3Client);
const bedrockMock = mockClient(BedrockRuntimeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const CASE_ID = "55555555-5555-4555-8555-555555555555";
const IMAGE_ID = "66666666-6666-4666-9666-666666666666";
const S3_KEY = `raw-images/recipient-demo-01/${CASE_ID}/${IMAGE_ID}.jpg`;

const validObservation = {
  personDetected: true,
  posture: "lying_or_fallen",
  riskIndicators: ["POSSIBLE_FALL"],
  needsHumanReview: true,
  confidence: 0.72,
  summary: "Persona en el suelo, sin movimiento aparente.",
};

const input: AnalyzeEvidenceInput = {
  caseDetail: {
    caseId: CASE_ID,
    deviceId: "pi-demo-01",
    recipientId: "recipient-demo-01",
    eventId: "22222222-2222-4222-9222-222222222222",
    eventType: "VISUAL_ANOMALY",
    anomalyType: "PERSON_PRONE_INACTIVE",
    occurredAt: "2026-09-24T18:30:00Z",
  },
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:SenseCareCaseStateMachine:abc",
  evidenceS3Key: S3_KEY,
  evidenceImageId: IMAGE_ID,
};

function fakeImageBody(bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0x00, 0x01])) {
  return { transformToByteArray: async () => bytes } as never;
}

function converseTextResponse(text: string): ConverseCommandOutput {
  return {
    output: { message: { role: "assistant", content: [{ text }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    metrics: { latencyMs: 500 },
  } as ConverseCommandOutput;
}

beforeEach(() => {
  s3Mock.reset();
  bedrockMock.reset();
  ddbMock.reset();
  s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/jpeg", ContentLength: 12345 });
  s3Mock.on(GetObjectCommand).resolves({ Body: fakeImageBody() });
  ddbMock.on(PutCommand).resolves({});
});

describe("analyzeEvidenceFn", () => {
  it("valid JPEG + valid Bedrock JSON -> COMPLETED with the exact observation, ANALYSIS_REQUESTED logged", async () => {
    bedrockMock.on(ConverseCommand).resolves(converseTextResponse(JSON.stringify(validObservation)));

    const result = await handler(input);

    expect(result).toEqual({ analysisStatus: "COMPLETED", observation: validObservation, failureReason: null });

    const converseInput = bedrockMock.commandCalls(ConverseCommand)[0]?.args[0].input;
    expect(converseInput?.modelId).toBe("us.amazon.nova-lite-v1:0");

    const eventLogItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(eventLogItem?.eventType).toBe("ANALYSIS_REQUESTED");
    expect(eventLogItem?.caseId).toBe(CASE_ID);
  });

  it("accepts a response wrapped in a markdown JSON fence", async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolves(converseTextResponse("```json\n" + JSON.stringify(validObservation) + "\n```"));

    const result = await handler(input);

    expect(result.analysisStatus).toBe("COMPLETED");
  });

  it("wrong Content-Type on HeadObject -> UNCERTAIN/INTERNAL_ERROR, Bedrock never called, no ANALYSIS_REQUESTED logged", async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 12345 });

    const result = await handler(input);

    expect(result).toEqual({ analysisStatus: "UNCERTAIN", observation: null, failureReason: "INTERNAL_ERROR" });
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("oversized object on HeadObject -> UNCERTAIN/INTERNAL_ERROR, Bedrock never called", async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/jpeg", ContentLength: 1_048_577 });

    const result = await handler(input);

    expect(result.failureReason).toBe("INTERNAL_ERROR");
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);
  });

  it("caseId embedded in evidenceS3Key does not match caseDetail.caseId -> UNCERTAIN/INTERNAL_ERROR, S3 never touched", async () => {
    const otherCaseId = "99999999-9999-4999-8999-999999999999";
    const badInput: AnalyzeEvidenceInput = {
      ...input,
      evidenceS3Key: `raw-images/recipient-demo-01/${otherCaseId}/${IMAGE_ID}.jpg`,
    };

    const result = await handler(badInput);

    expect(result.failureReason).toBe("INTERNAL_ERROR");
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);
  });

  it("non-JSON model response -> UNCERTAIN/INVALID_OUTPUT", async () => {
    bedrockMock.on(ConverseCommand).resolves(converseTextResponse("no soy json"));

    const result = await handler(input);

    expect(result).toEqual({ analysisStatus: "UNCERTAIN", observation: null, failureReason: "INVALID_OUTPUT" });
  });

  it("JSON response that fails the observation schema -> UNCERTAIN/INVALID_OUTPUT", async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolves(converseTextResponse(JSON.stringify({ ...validObservation, posture: "sitting" })));

    const result = await handler(input);

    expect(result.failureReason).toBe("INVALID_OUTPUT");
  });

  it("AccessDeniedException is caught internally -> UNCERTAIN/MODEL_UNAVAILABLE, never rethrows", async () => {
    bedrockMock.on(ConverseCommand).rejects(new AccessDeniedException({ message: "denied", $metadata: {} }));

    await expect(handler(input)).resolves.toEqual({
      analysisStatus: "UNCERTAIN",
      observation: null,
      failureReason: "MODEL_UNAVAILABLE",
    });
  });

  it("ResourceNotFoundException is caught internally -> UNCERTAIN/MODEL_UNAVAILABLE", async () => {
    bedrockMock
      .on(ConverseCommand)
      .rejects(new ResourceNotFoundException({ message: "not found", $metadata: {} }));

    await expect(handler(input)).resolves.toEqual({
      analysisStatus: "UNCERTAIN",
      observation: null,
      failureReason: "MODEL_UNAVAILABLE",
    });
  });

  it("ValidationException is caught internally -> UNCERTAIN/INTERNAL_ERROR", async () => {
    bedrockMock.on(ConverseCommand).rejects(new ValidationException({ message: "bad request", $metadata: {} }));

    await expect(handler(input)).resolves.toEqual({
      analysisStatus: "UNCERTAIN",
      observation: null,
      failureReason: "INTERNAL_ERROR",
    });
  });

  it("ThrottlingException is NOT caught: the handler rejects so Step Functions can retry", async () => {
    bedrockMock.on(ConverseCommand).rejects(new ThrottlingException({ message: "slow down", $metadata: {} }));

    await expect(handler(input)).rejects.toBeInstanceOf(ThrottlingException);
  });

  it("never sends recipientId, deviceId or caseId in the prompt text sent to Bedrock", async () => {
    bedrockMock.on(ConverseCommand).resolves(converseTextResponse(JSON.stringify(validObservation)));

    await handler(input);

    const converseInput = bedrockMock.commandCalls(ConverseCommand)[0]?.args[0].input;
    const serialized = JSON.stringify(converseInput);
    expect(serialized).not.toContain(input.caseDetail.recipientId);
    expect(serialized).not.toContain(input.caseDetail.deviceId);
    expect(serialized).not.toContain(CASE_ID);
  });
});
