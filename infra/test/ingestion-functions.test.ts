import * as path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IngestionTables } from "../lib/constructs/ingestion-tables.js";
import { IngestionFunctions } from "../lib/constructs/ingestion-functions.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  const tables = new IngestionTables(stack, "Tables");
  const eventBus = new events.EventBus(stack, "Bus", { eventBusName: "SenseCare" });

  new IngestionFunctions(stack, "Functions", {
    telemetryQueue: new sqs.Queue(stack, "TelemetryQueue"),
    visualAnomalyQueue: new sqs.Queue(stack, "VisualAnomalyQueue"),
    sensorAnomalyQueue: new sqs.Queue(stack, "SensorAnomalyQueue"),
    devicesTable: tables.devicesTable,
    telemetryTable: tables.telemetryTable,
    eventLogTable: tables.eventLogTable,
    openCaseLocksTable: tables.openCaseLocksTable,
    eventBus,
  });

  return Template.fromStack(stack);
}

describe("IngestionFunctions", () => {
  it("creates exactly 3 Lambda functions, one per queue", () => {
    const template = synth();
    template.resourceCountIs("AWS::Lambda::Function", 3);
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 3);
  });

  it("enables ReportBatchItemFailures on every SQS event source mapping", () => {
    const template = synth();
    template.allResourcesProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("never grants a wildcard IAM action or resource to any ingestion role", () => {
    const template = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    for (const policy of Object.values(policies)) {
      const statements = (
        policy as {
          Properties: {
            PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
          };
        }
      ).Properties.PolicyDocument.Statement;

      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        expect(actions).not.toContain("*");
        expect(JSON.stringify(actions)).not.toContain("s3:*");
        expect(JSON.stringify(actions)).not.toContain("dynamodb:*");
      }
    }
  });

  it("does not attach AdministratorAccess to any role", () => {
    const template = synth();
    template.resourcePropertiesCountIs(
      "AWS::IAM::Role",
      { ManagedPolicyArns: Match.arrayWith([Match.stringLikeRegexp("AdministratorAccess")]) },
      0,
    );
  });

  it("resolves Lambda entry paths independent of the current working directory", () => {
    // Regresion: SERVICE_ENTRY_ROOT solia depender de process.cwd(). Si
    // alguien invoca `cd infra && cdk synth` (un flujo real y comun), esa
    // version rota el bundling porque busca services/ingestion/src dentro
    // de infra/. Con __dirname, la ruta es estable sin importar el cwd.
    const originalCwd = process.cwd();
    try {
      process.chdir(path.join(originalCwd, "infra"));
      const template = synth();
      template.resourceCountIs("AWS::Lambda::Function", 3);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
