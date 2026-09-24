import { App, Stack } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { validateCommandAck } from "@sensecare/contracts";
import { EvidenceCallbackRules } from "../lib/constructs/evidence-callback-rules.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new EvidenceCallbackRules(stack, "Rules", {
    commandAcksQueue: new sqs.Queue(stack, "CommandAcksQueue"),
    evidenceQueue: new sqs.Queue(stack, "EvidenceQueue"),
  });
  return Template.fromStack(stack);
}

describe("EvidenceCallbackRules", () => {
  it("creates exactly 2 IoT topic rules", () => {
    const template = synth();
    template.resourceCountIs("AWS::IoT::TopicRule", 2);
  });

  it("filters each rule to its own callback topic", () => {
    const template = synth();
    const rules = template.findResources("AWS::IoT::TopicRule");
    const sqlStatements = Object.values(rules).map(
      (r) => (r as { Properties: { TopicRulePayload: { Sql: string } } }).Properties.TopicRulePayload.Sql,
    );

    expect(sqlStatements.some((sql) => sql.includes("SenseCare/v1/devices/+/command-acks"))).toBe(true);
    expect(sqlStatements.some((sql) => sql.includes("SenseCare/v1/devices/+/evidence"))).toBe(true);
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

    expect(sendMessagePolicies).toHaveLength(2);

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
      expect(sql).not.toMatch(/\btopic\(\)/);
      expect(sql).not.toMatch(/\btimestamp\(\)/);
    }
  });

  it("demonstrates why handlers must strip mqttDeviceId before schema validation", () => {
    // Igual que en iot-ingestion-rules.ts (Hito 2): topic(4) AS mqttDeviceId
    // agrega un metadato de transporte que additionalProperties:false
    // rechaza si no se separa antes de validar (ver
    // services/evidence/src/envelope.ts).
    const cleanAck = {
      eventId: "11111111-1111-4111-8111-111111111111",
      commandId: "44444444-4444-4444-b444-444444444444",
      caseId: "55555555-5555-4555-8555-555555555555",
      command: "UPLOAD_EVIDENCE",
      occurredAt: "2026-09-24T18:30:30Z",
      accepted: true,
    };
    const rawEnvelopeFromRule = { ...cleanAck, mqttDeviceId: "pi-demo-01" };

    expect(validateCommandAck(rawEnvelopeFromRule)).toBe(false);
    expect(validateCommandAck(cleanAck)).toBe(true);
  });
});
