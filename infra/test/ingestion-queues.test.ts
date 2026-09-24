import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IngestionQueues } from "../lib/constructs/ingestion-queues.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new IngestionQueues(stack, "Queues");
  return Template.fromStack(stack);
}

describe("IngestionQueues", () => {
  it("creates 3 main queues and 3 dead-letter queues", () => {
    const template = synth();
    template.resourceCountIs("AWS::SQS::Queue", 6);
  });

  it("gives each main queue its own DLQ with maxReceiveCount 5", () => {
    const template = synth();
    for (const name of ["SenseCare-telemetry", "SenseCare-visual-anomaly", "SenseCare-sensor-anomaly"]) {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: name,
        RedrivePolicy: { maxReceiveCount: 5 },
        VisibilityTimeout: 90,
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
