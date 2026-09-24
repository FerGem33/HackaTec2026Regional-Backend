import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IngestionTables } from "../lib/constructs/ingestion-tables.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new IngestionTables(stack, "Tables");
  return Template.fromStack(stack);
}

describe("IngestionTables", () => {
  it("creates exactly four PAY_PER_REQUEST DynamoDB tables", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 4);
    template.allResourcesProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("keys Devices by deviceId only, retained on stack deletion", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-Devices",
        KeySchema: [{ AttributeName: "deviceId", KeyType: "HASH" }],
      },
    });
  });

  it("keys Telemetry by deviceId/occurredAtEventId with TTL on expiresAt, retained", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-Telemetry",
        KeySchema: [
          { AttributeName: "deviceId", KeyType: "HASH" },
          { AttributeName: "occurredAtEventId", KeyType: "RANGE" },
        ],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      },
    });
  });

  it("keys EventLog by caseId/occurredAtEventId, retained", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-EventLog",
        KeySchema: [
          { AttributeName: "caseId", KeyType: "HASH" },
          { AttributeName: "occurredAtEventId", KeyType: "RANGE" },
        ],
      },
    });
  });

  it("keys OpenCaseLocks by lockKey with TTL on expiresAt, retained", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-OpenCaseLocks",
        KeySchema: [{ AttributeName: "lockKey", KeyType: "HASH" }],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      },
    });
  });
});
