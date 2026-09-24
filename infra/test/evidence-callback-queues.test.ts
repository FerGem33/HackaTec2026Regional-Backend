import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EvidenceCallbackQueues } from "../lib/constructs/evidence-callback-queues.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new EvidenceCallbackQueues(stack, "Queues");
  return Template.fromStack(stack);
}

describe("EvidenceCallbackQueues", () => {
  it("creates 2 main queues and 2 dead-letter queues", () => {
    const template = synth();
    template.resourceCountIs("AWS::SQS::Queue", 4);
  });

  it("gives each main queue its own DLQ with maxReceiveCount 5 and a 20s visibility timeout (shorter than the general SenseCare 6x rule, on purpose)", () => {
    const template = synth();
    for (const name of ["SenseCare-command-acks", "SenseCare-evidence"]) {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: name,
        RedrivePolicy: { maxReceiveCount: 5 },
        VisibilityTimeout: 20,
      });
    }
  });

  it("uses SQS-managed encryption on every queue", () => {
    const template = synth();
    template.allResourcesProperties("AWS::SQS::Queue", {
      SqsManagedSseEnabled: true,
    });
  });
});
