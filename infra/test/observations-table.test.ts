import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ObservationsTable } from "../lib/constructs/observations-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new ObservationsTable(stack, "Table");
  return Template.fromStack(stack);
}

describe("ObservationsTable", () => {
  it("creates exactly one PAY_PER_REQUEST table keyed by caseId/imageId, retained on deletion", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-Observations",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "caseId", KeyType: "HASH" },
          { AttributeName: "imageId", KeyType: "RANGE" },
        ],
      },
    });
  });

  it("configures TTL on ttlEpochSeconds (numeric epoch attribute, protects the narrative summary)", () => {
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "ttlEpochSeconds", Enabled: true },
    });
  });

  it("does not define a GSI", () => {
    const template = synth();
    const tables = template.findResources("AWS::DynamoDB::Table");
    const [table] = Object.values(tables);
    expect(
      (table as { Properties: Record<string, unknown> }).Properties.GlobalSecondaryIndexes,
    ).toBeUndefined();
  });
});
