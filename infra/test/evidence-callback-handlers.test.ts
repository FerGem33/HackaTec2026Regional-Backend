import { App, Stack } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EvidenceCallbackHandlers } from "../lib/constructs/evidence-callback-handlers.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  const evidenceCallbacksTable = new dynamodb.Table(stack, "EvidenceCallbacksTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "callbackType", type: dynamodb.AttributeType.STRING },
  });
  const eventLogTable = new dynamodb.Table(stack, "EventLogTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "occurredAtEventId", type: dynamodb.AttributeType.STRING },
  });
  const evidenceBucket = new s3.Bucket(stack, "EvidenceBucket");

  new EvidenceCallbackHandlers(stack, "Handlers", {
    commandAcksQueue: new sqs.Queue(stack, "CommandAcksQueue"),
    evidenceQueue: new sqs.Queue(stack, "EvidenceQueue"),
    evidenceCallbacksTable,
    eventLogTable,
    evidenceBucket,
  });

  return Template.fromStack(stack);
}

function policyStatements(
  template: Template,
): Array<{ Action: unknown; Resource: unknown }> {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (p) =>
      (
        p as { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } } }
      ).Properties.PolicyDocument.Statement,
  );
}

describe("EvidenceCallbackHandlers", () => {
  it("creates exactly the 2 SQS-triggered Lambdas, both consuming their own queue with ReportBatchItemFailures", () => {
    const template = synth();
    const functions = template.findResources("AWS::Lambda::Function");
    expect(Object.keys(functions)).toHaveLength(2);

    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 2);
    template.allResourcesProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("does not reserve concurrency on either Lambda", () => {
    const template = synth();
    const functions = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(functions)) {
      expect(
        (fn as { Properties: Record<string, unknown> }).Properties.ReservedConcurrentExecutions,
      ).toBeUndefined();
    }
  });

  it("grants commandAckHandlerFn only GetItem/UpdateItem on EvidenceCallbacks and PutItem on EventLog", () => {
    const template = synth();
    const statements = policyStatements(template);

    const ddbStatement = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return (
        actions.length === 2 &&
        actions.includes("dynamodb:GetItem") &&
        actions.includes("dynamodb:UpdateItem")
      );
    });
    expect(ddbStatement).toBeDefined();

    const eventLogStatement = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "dynamodb:PutItem";
    });
    expect(eventLogStatement).toBeDefined();
  });

  it("grants evidenceCallbackHandlerFn s3:GetObject/s3:DeleteObject scoped to raw-images/* only, never the whole bucket or s3:*", () => {
    const template = synth();
    const statements = policyStatements(template);

    const s3Statement = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("s3:GetObject") && actions.includes("s3:DeleteObject");
    });
    expect(s3Statement).toBeDefined();
    expect(JSON.stringify(s3Statement?.Resource)).toContain("raw-images/*");
    expect(JSON.stringify(s3Statement?.Action)).not.toContain("s3:*");
  });

  it("grants states:SendTaskSuccess/SendTaskFailure with Resource:'*' on both Lambdas (the only AWS-mandated exception), and never Action:'*'", () => {
    const template = synth();
    const statements = policyStatements(template);

    const sendTaskStatements = statements.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("states:SendTaskSuccess") || actions.includes("states:SendTaskFailure");
    });
    expect(sendTaskStatements).toHaveLength(2);
    for (const statement of sendTaskStatements) {
      expect(statement.Action).toEqual(
        expect.arrayContaining(["states:SendTaskSuccess", "states:SendTaskFailure"]),
      );
      expect(statement.Resource).toBe("*");
    }

    for (const statement of statements) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      expect(actions).not.toContain("*");
      expect(JSON.stringify(actions)).not.toContain("dynamodb:*");
      expect(JSON.stringify(actions)).not.toContain("s3:*");
      expect(JSON.stringify(actions)).not.toContain("states:*");
    }
  });

  it("never attaches AdministratorAccess to any role", () => {
    const template = synth();
    template.resourcePropertiesCountIs(
      "AWS::IAM::Role",
      { ManagedPolicyArns: Match.arrayWith([Match.stringLikeRegexp("AdministratorAccess")]) },
      0,
    );
  });
});
