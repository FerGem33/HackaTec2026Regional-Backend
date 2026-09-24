import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AnomalyCasesTable } from "../lib/constructs/anomaly-cases-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new AnomalyCasesTable(stack, "Table");
  return Template.fromStack(stack);
}

describe("AnomalyCasesTable", () => {
  it("creates exactly one PAY_PER_REQUEST table keyed by caseId, retained on deletion", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-AnomalyCases",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "caseId", KeyType: "HASH" }],
      },
    });
  });

  it("does not configure a TTL attribute (a case is a durable record, not an ephemeral lock)", () => {
    const template = synth();
    const tables = template.findResources("AWS::DynamoDB::Table");
    const [table] = Object.values(tables);
    expect((table as { Properties: Record<string, unknown> }).Properties.TimeToLiveSpecification).toBeUndefined();
  });

  it("adds an AnomalyCasesByDevice GSI (PK deviceId, SK createdAt) with a limited, safe projection", () => {
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "SenseCare-AnomalyCases",
      GlobalSecondaryIndexes: [
        {
          IndexName: "AnomalyCasesByDevice",
          KeySchema: [
            { AttributeName: "deviceId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: {
            ProjectionType: "INCLUDE",
            NonKeyAttributes: [
              "eventType",
              "anomalyType",
              "severity",
              "status",
              "alertStatus",
              "evidenceStatus",
              "analysisStatus",
              "updatedAt",
            ],
          },
        },
      ],
    });
  });

  it("never projects evidence S3 keys/image ids or Bedrock-derived text onto the GSI", () => {
    const template = synth();
    const [table] = Object.values(template.findResources("AWS::DynamoDB::Table")) as Array<{
      Properties: { GlobalSecondaryIndexes: Array<{ Projection: { NonKeyAttributes: string[] } }> };
    }>;
    const projected = table.Properties.GlobalSecondaryIndexes[0]?.Projection.NonKeyAttributes ?? [];
    for (const forbidden of ["evidenceS3Key", "evidenceImageId", "evidenceReason", "analysisRiskIndicators"]) {
      expect(projected).not.toContain(forbidden);
    }
  });
});
