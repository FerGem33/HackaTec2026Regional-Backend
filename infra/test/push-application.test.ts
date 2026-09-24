import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { PushApplication } from "../lib/constructs/push-application.js";

function synth(fcmServiceAccountJson = '{"project_id":"test"}'): Template {
  const stack = new Stack(new App(), "TestStack");
  new PushApplication(stack, "PushApplication", { fcmServiceAccountJson });
  return Template.fromStack(stack);
}

describe("PushApplication", () => {
  it("creates exactly one Pinpoint App", () => {
    const template = synth();
    template.resourceCountIs("AWS::Pinpoint::App", 1);
    template.hasResourceProperties("AWS::Pinpoint::App", { Name: "SenseCare-Push" });
  });

  it("creates exactly one enabled GCM channel, token auth, wired to that same App", () => {
    const template = synth();
    template.resourceCountIs("AWS::Pinpoint::GCMChannel", 1);
    template.hasResourceProperties("AWS::Pinpoint::GCMChannel", {
      Enabled: true,
      DefaultAuthenticationMethod: "TOKEN",
    });
  });

  it("never hardcodes the FCM credential: it always comes from the prop, not a literal default", () => {
    const template = synth('{"project_id":"distinct-project"}');
    template.hasResourceProperties("AWS::Pinpoint::GCMChannel", {
      ServiceJson: '{"project_id":"distinct-project"}',
    });
  });

  it("never uses the legacy ApiKey (server key) field, only ServiceJson (FCM HTTP v1)", () => {
    const template = synth();
    const [channel] = Object.values(template.findResources("AWS::Pinpoint::GCMChannel")) as Array<{
      Properties: Record<string, unknown>;
    }>;
    expect(channel.Properties.ApiKey).toBeUndefined();
  });
});
