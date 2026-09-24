import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DeviceAccessPolicy } from "../lib/constructs/device-access-policy.js";

interface PolicyStatement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, string>>;
}

/**
 * Cada ARN se construye con cdk.Aws.REGION/ACCOUNT_ID, asi que CDK lo
 * sintetiza como Fn::Join (no un string plano). El ultimo elemento del
 * join es el texto literal que nos interesa
 * (".../${iot:Connection.Thing.ThingName}/<suffix>").
 */
function literalTail(resource: unknown): string {
  if (typeof resource === "string") {
    return resource;
  }
  const parts = (resource as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"]?.[1] ?? [];
  const lastPart = parts[parts.length - 1];
  return typeof lastPart === "string" ? lastPart : "";
}

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new DeviceAccessPolicy(stack, "Policy");
  return Template.fromStack(stack);
}

describe("DeviceAccessPolicy", () => {
  it("creates exactly one AWS::IoT::Policy, with no Thing/Certificate/attachment resources", () => {
    const template = synth();
    template.resourceCountIs("AWS::IoT::Policy", 1);
    template.resourceCountIs("AWS::IoT::Thing", 0);
    template.resourceCountIs("AWS::IoT::Certificate", 0);
    template.resourceCountIs("AWS::IoT::PolicyPrincipalAttachment", 0);
    template.resourceCountIs("AWS::IoT::ThingPrincipalAttachment", 0);
  });

  it("scopes every statement to ${iot:Connection.Thing.ThingName}, never a wildcard topic", () => {
    const template = synth();
    const policies = template.findResources("AWS::IoT::Policy");
    const [policy] = Object.values(policies);
    const statements = (
      policy as { Properties: { PolicyDocument: { Statement: PolicyStatement[] } } }
    ).Properties.PolicyDocument.Statement;

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      for (const resource of resources) {
        expect(literalTail(resource)).toContain("${iot:Connection.Thing.ThingName}");
      }
      const tails = resources.map(literalTail).join(",");
      expect(tails).not.toContain("SenseCare/#");
      expect(tails).not.toMatch(/topic\/SenseCare\/v1\/devices\/\+/);
    }
  });

  it("covers exactly the six MQTT publish topics plus commands subscribe/receive", () => {
    const template = synth();
    const policies = template.findResources("AWS::IoT::Policy");
    const [policy] = Object.values(policies);
    const statements = (
      policy as { Properties: { PolicyDocument: { Statement: PolicyStatement[] } } }
    ).Properties.PolicyDocument.Statement;

    const publishStatement = statements.find((s) => s.Action === "iot:Publish");
    const publishResources = Array.isArray(publishStatement?.Resource)
      ? publishStatement?.Resource
      : [publishStatement?.Resource];
    const publishTails = publishResources.map(literalTail);
    for (const suffix of [
      "telemetry",
      "visual/anomaly",
      "sensor/anomaly",
      "status",
      "command-acks",
      "evidence",
    ]) {
      expect(publishTails.some((tail) => tail.endsWith(`/${suffix}`))).toBe(true);
    }

    expect(statements.some((s) => s.Action === "iot:Subscribe")).toBe(true);
    expect(statements.some((s) => s.Action === "iot:Receive")).toBe(true);
  });

  it("requires iot:Connection.Thing.IsAttached=true on Connect, Publish, Subscribe and Receive", () => {
    const template = synth();
    const policies = template.findResources("AWS::IoT::Policy");
    const [policy] = Object.values(policies);
    const statements = (
      policy as { Properties: { PolicyDocument: { Statement: PolicyStatement[] } } }
    ).Properties.PolicyDocument.Statement;

    const actionsRequiringAttachment = ["iot:Connect", "iot:Publish", "iot:Subscribe", "iot:Receive"];
    expect(statements).toHaveLength(actionsRequiringAttachment.length);

    for (const action of actionsRequiringAttachment) {
      const statement = statements.find((s) => s.Action === action);
      expect(statement?.Condition).toEqual({
        Bool: { "iot:Connection.Thing.IsAttached": "true" },
      });
    }
  });
});
