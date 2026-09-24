import { App, Stack } from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DlqAlarms } from "../lib/constructs/dlq-alarms.js";

function synth(): { template: Template; operationalTopic: sns.Topic } {
  const stack = new Stack(new App(), "TestStack");
  const operationalTopic = new sns.Topic(stack, "OperationalAlarmsTopic");

  new DlqAlarms(stack, "DlqAlarms", {
    operationalAlarmsTopic: operationalTopic,
    deadLetterQueues: {
      Telemetry: new sqs.Queue(stack, "TelemetryDlq"),
      VisualAnomaly: new sqs.Queue(stack, "VisualAnomalyDlq"),
      SensorAnomaly: new sqs.Queue(stack, "SensorAnomalyDlq"),
      CommandAcks: new sqs.Queue(stack, "CommandAcksDlq"),
      Evidence: new sqs.Queue(stack, "EvidenceDlq"),
      CaseDispatcher: new sqs.Queue(stack, "CaseDispatcherDlq"),
    },
  });

  return { template: Template.fromStack(stack), operationalTopic };
}

describe("DlqAlarms", () => {
  it("creates exactly one alarm per DLQ (6 total)", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  });

  it("every alarm watches ApproximateNumberOfMessagesVisible >= 1 and treats missing data as not breaching", () => {
    const { template } = synth();
    const alarms = template.findResources("AWS::CloudWatch::Alarm");

    for (const alarm of Object.values(alarms)) {
      const props = (alarm as { Properties: Record<string, unknown> }).Properties;
      expect(props.MetricName).toBe("ApproximateNumberOfMessagesVisible");
      expect(props.Threshold).toBe(1);
      expect(props.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
      expect(props.TreatMissingData).toBe("notBreaching");
    }
  });

  it("every alarm's action targets the operational topic, never the family-facing alerts topic", () => {
    const { template } = synth();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmActions: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp("OperationalAlarmsTopic") })]),
    });

    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    expect(Object.keys(alarms)).toHaveLength(6);
    for (const alarm of Object.values(alarms)) {
      const props = (alarm as { Properties: { AlarmActions: unknown[]; OKActions: unknown[] } }).Properties;
      expect(props.AlarmActions).toHaveLength(1);
      expect(props.OKActions).toHaveLength(1);
    }
  });
});
