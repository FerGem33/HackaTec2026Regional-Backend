import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CaregiverPushEndpointsTable } from "../lib/constructs/caregiver-push-endpoints-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new CaregiverPushEndpointsTable(stack, "Table");
  return Template.fromStack(stack);
}

describe("CaregiverPushEndpointsTable", () => {
  it("creates exactly one table keyed by userId (PK) + endpointId (SK)", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "SenseCare-CaregiverPushEndpoints",
      KeySchema: [
        { AttributeName: "userId", KeyType: "HASH" },
        { AttributeName: "endpointId", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("retains the table on stack deletion (registro durable de preferencias del usuario)", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
  });
});
