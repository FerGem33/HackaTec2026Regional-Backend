import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CaregiverAccessTable } from "../lib/constructs/caregiver-access-table.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new CaregiverAccessTable(stack, "CaregiverAccessTable");
  return Template.fromStack(stack);
}

describe("CaregiverAccessTable", () => {
  it("creates exactly one table keyed by userId (PK) + deviceId (SK)", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "userId", KeyType: "HASH" },
        { AttributeName: "deviceId", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("retains the table on stack deletion", () => {
    const template = synth();
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
  });
});
