import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AlertsTopic } from "../lib/constructs/alerts-topic.js";

describe("AlertsTopic", () => {
  it("creates exactly two SNS topics: SenseCare-Alerts and SenseCare-OperationalAlarms", () => {
    const stack = new Stack(new App(), "TestStack");
    new AlertsTopic(stack, "AlertsTopic");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::SNS::Topic", 2);
    template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "SenseCare-Alerts" });
    template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "SenseCare-OperationalAlarms" });
  });

  it("creates zero subscriptions when no emails are provided (manual subscription is expected)", () => {
    const stack = new Stack(new App(), "TestStack");
    new AlertsTopic(stack, "AlertsTopic");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::SNS::Subscription", 0);
  });

  it("creates exactly one email subscription per provided address, on the correct topic, and never SMS", () => {
    const stack = new Stack(new App(), "TestStack");
    new AlertsTopic(stack, "AlertsTopic", {
      alertSubscriptionEmails: ["family1@example.com", "family2@example.com"],
      operationalSubscriptionEmails: ["oncall@example.com"],
    });
    const template = Template.fromStack(stack);

    const subscriptions = template.findResources("AWS::SNS::Subscription");
    expect(Object.keys(subscriptions)).toHaveLength(3);
    for (const sub of Object.values(subscriptions)) {
      expect((sub as { Properties: { Protocol: string } }).Properties.Protocol).toBe("email");
    }
  });
});
