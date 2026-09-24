import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EvidenceCallbacksTable } from "../lib/constructs/evidence-callbacks-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new EvidenceCallbacksTable(stack, "Table");
  return Template.fromStack(stack);
}

describe("EvidenceCallbacksTable", () => {
  it("creates exactly one PAY_PER_REQUEST table keyed by caseId/callbackType, retained on deletion", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        TableName: "SenseCare-EvidenceCallbacks",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "caseId", KeyType: "HASH" },
          { AttributeName: "callbackType", KeyType: "RANGE" },
        ],
      },
    });
  });

  it("configures TTL on ttlEpochSeconds (numeric epoch attribute, never an ISO string)", () => {
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
