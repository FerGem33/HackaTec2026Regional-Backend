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
});
