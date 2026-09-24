import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DemoAuth } from "../lib/constructs/demo-auth.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new DemoAuth(stack, "DemoAuth");
  return Template.fromStack(stack);
}

describe("DemoAuth", () => {
  it("creates exactly one User Pool and one client without a secret", () => {
    const template = synth();
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
    });
  });

  it("disables public self sign-up: demo users are created out-of-band", () => {
    const template = synth();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });
});
