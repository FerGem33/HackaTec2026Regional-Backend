import { App, Stack } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { validateTelemetry } from "@sensecare/contracts";
import { IotIngestionRules } from "../lib/constructs/iot-ingestion-rules.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new IotIngestionRules(stack, "Rules", {
    telemetryQueue: new sqs.Queue(stack, "TelemetryQueue"),
    visualAnomalyQueue: new sqs.Queue(stack, "VisualAnomalyQueue"),
    sensorAnomalyQueue: new sqs.Queue(stack, "SensorAnomalyQueue"),
  });
  return Template.fromStack(stack);
}

describe("IotIngestionRules", () => {
  it("creates exactly 3 IoT topic rules", () => {
    const template = synth();
    template.resourceCountIs("AWS::IoT::TopicRule", 3);
  });

  it("filters each rule to its own topic", () => {
    const template = synth();
    const rules = template.findResources("AWS::IoT::TopicRule");
    const sqlStatements = Object.values(rules).map(
      (r) => (r as { Properties: { TopicRulePayload: { Sql: string } } }).Properties.TopicRulePayload.Sql,
    );

    expect(sqlStatements.some((sql) => sql.includes("SenseCare/v1/devices/+/telemetry"))).toBe(true);
    expect(sqlStatements.some((sql) => sql.includes("SenseCare/v1/devices/+/visual/anomaly"))).toBe(
      true,
    );
    expect(sqlStatements.some((sql) => sql.includes("SenseCare/v1/devices/+/sensor/anomaly"))).toBe(
      true,
    );
  });

  it("gives each rule's IAM role sqs:SendMessage scoped to exactly one queue ARN (no wildcards)", () => {
    const template = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    const sendMessagePolicies = Object.values(policies).filter((policy) => {
      const statements = (
        policy as {
          Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } };
        }
      ).Properties.PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes("sqs:SendMessage");
      });
    });

    expect(sendMessagePolicies).toHaveLength(3);

    for (const policy of sendMessagePolicies) {
      const statements = (
        policy as {
          Properties: {
            PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
          };
        }
      ).Properties.PolicyDocument.Statement;
      const sendStatement = statements.find((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes("sqs:SendMessage");
      });
      expect(JSON.stringify(sendStatement?.Resource)).not.toContain('"*"');
    }
  });

  it("uses SELECT * plus topic(4) AS mqttDeviceId, without other computed columns", () => {
    const template = synth();
    const rules = template.findResources("AWS::IoT::TopicRule");
    const sqlStatements = Object.values(rules).map(
      (r) => (r as { Properties: { TopicRulePayload: { Sql: string } } }).Properties.TopicRulePayload.Sql,
    );

    for (const sql of sqlStatements) {
      expect(sql).toMatch(/^SELECT \*, topic\(4\) AS mqttDeviceId FROM '/);
      // Regresion: no debe reintroducir columnas como "topic() AS
      // mqttTopic" o "timestamp() AS receivedAt", que
      // additionalProperties:false rechazaria en el Lambda de ingesta
      // para TODO mensaje real (deviceId es el 4to segmento del topic;
      // topic() sin indice o timestamp() no son necesarios ni deseados).
      expect(sql).not.toMatch(/\btopic\(\)/);
      expect(sql).not.toMatch(/\btimestamp\(\)/);
    }
  });

  it("demonstrates why handlers must strip mqttDeviceId before schema validation", () => {
    // topic(4) AS mqttDeviceId agrega un campo de metadato de transporte
    // al documento que la Rule entrega a SQS. Los contratos son estrictos
    // (additionalProperties:false), asi que el envelope crudo NO pasa el
    // validador: cada handler debe separar mqttDeviceId antes de validar
    // (ver services/ingestion/src/envelope.ts).
    const cleanTelemetry = {
      eventId: "11111111-1111-4111-8111-111111111111",
      deviceId: "pi-demo-01",
      occurredAt: "2026-09-23T18:30:00Z",
      firmwareVersion: "0.1.0",
    };
    const rawEnvelopeFromRule = { ...cleanTelemetry, mqttDeviceId: "pi-demo-01" };

    expect(validateTelemetry(rawEnvelopeFromRule)).toBe(false);
    expect(validateTelemetry(cleanTelemetry)).toBe(true);
  });
});
