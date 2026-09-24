import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AlertsTable } from "../lib/constructs/alerts-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new AlertsTable(stack, "AlertsTable");
  return Template.fromStack(stack);
}

describe("AlertsTable", () => {
  it("creates exactly one table keyed only by caseId, with no TTL attribute", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "SenseCare-Alerts",
      KeySchema: [{ AttributeName: "caseId", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    });
    const [table] = Object.values(template.findResources("AWS::DynamoDB::Table"));
    expect((table as { Properties: Record<string, unknown> }).Properties.TimeToLiveSpecification).toBeUndefined();
  });

  it("retains the table on stack deletion (trazabilidad funcional del caso, no un dato efimero)", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
  });
});
