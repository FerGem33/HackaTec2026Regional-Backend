import { App, Stack } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IngestionTables } from "../lib/constructs/ingestion-tables.js";
import { CaregiverAccessTable } from "../lib/constructs/caregiver-access-table.js";
import { DemoAuth } from "../lib/constructs/demo-auth.js";
import { DemoIngestApi } from "../lib/constructs/demo-ingest-api.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  const auth = new DemoAuth(stack, "DemoAuth");
  const tables = new IngestionTables(stack, "Tables");
  const caregiverAccess = new CaregiverAccessTable(stack, "CaregiverAccessTable");
  new DemoIngestApi(stack, "DemoIngestApi", {
    telemetryQueue: new sqs.Queue(stack, "TelemetryQueue"),
    sensorAnomalyQueue: new sqs.Queue(stack, "SensorAnomalyQueue"),
    devicesTable: tables.devicesTable,
    telemetryTable: tables.telemetryTable,
    caregiverAccessTable: caregiverAccess.table,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    demoDeviceAllowlist: ["sim-room-01"],
  });
  return Template.fromStack(stack);
}

describe("DemoIngestApi", () => {
  it("creates exactly 4 Lambda functions (ingest + pair + 2 read routes) and one HTTP API", () => {
    const template = synth();
    template.resourceCountIs("AWS::Lambda::Function", 4);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  it("creates exactly 4 routes, all protected by the same JWT authorizer", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 4);
    for (const routeKey of [
      "POST /demo/devices/{deviceId}/events",
      "POST /devices/{deviceId}/pair",
      "GET /devices/{deviceId}/latest",
      "GET /devices/{deviceId}/telemetry",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "JWT",
      });
    }
  });

  it("passes the demo device allowlist only to the ingest Lambda, not the read/pair Lambdas", () => {
    const template = synth();
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "SenseCare-demoIngest",
      Environment: { Variables: Match.objectLike({ DEMO_DEVICE_ALLOWLIST: "sim-room-01" }) },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "SenseCare-pairDevice",
      Environment: { Variables: Match.not(Match.objectLike({ DEMO_DEVICE_ALLOWLIST: Match.anyValue() })) },
    });
  });

  it("gives the read Lambdas and the pair Lambda access to CaregiverAccessTable", () => {
    const template = synth();
    for (const functionName of ["SenseCare-getDeviceLatest", "SenseCare-getDeviceTelemetry", "SenseCare-pairDevice"]) {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: functionName,
        Environment: { Variables: Match.objectLike({ CAREGIVER_ACCESS_TABLE_NAME: Match.anyValue() }) },
      });
    }
  });

  it("never grants a wildcard IAM action or resource to any of the 4 Lambdas", () => {
    const template = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    for (const policy of Object.values(policies)) {
      const statements = (
        policy as {
          Properties: { PolicyDocument: { Statement: Array<{ Action: unknown }> } };
        }
      ).Properties.PolicyDocument.Statement;

      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        expect(actions).not.toContain("*");
        expect(JSON.stringify(actions)).not.toContain("sqs:*");
        expect(JSON.stringify(actions)).not.toContain("dynamodb:*");
      }
    }
  });
});
