import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AlertDeliveriesTable } from "../lib/constructs/alert-deliveries-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new AlertDeliveriesTable(stack, "Table");
  return Template.fromStack(stack);
}

describe("AlertDeliveriesTable", () => {
  it("creates exactly one table keyed by caseId (PK) + deliveryId (SK), for per-endpoint delivery auditing", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "SenseCare-AlertDeliveries",
      KeySchema: [
        { AttributeName: "caseId", KeyType: "HASH" },
        { AttributeName: "deliveryId", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("retains the table on stack deletion (auditoria funcional, no un dato efimero)", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
  });
});
