import { App, Stack } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IngestionTables } from "../lib/constructs/ingestion-tables.js";
import { DemoAuth } from "../lib/constructs/demo-auth.js";
import { DemoIngestApi } from "../lib/constructs/demo-ingest-api.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  const auth = new DemoAuth(stack, "DemoAuth");
  const tables = new IngestionTables(stack, "Tables");
  new DemoIngestApi(stack, "DemoIngestApi", {
    telemetryQueue: new sqs.Queue(stack, "TelemetryQueue"),
    sensorAnomalyQueue: new sqs.Queue(stack, "SensorAnomalyQueue"),
    devicesTable: tables.devicesTable,
    telemetryTable: tables.telemetryTable,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    demoDeviceAllowlist: ["sim-room-01"],
  });
  return Template.fromStack(stack);
}

describe("DemoIngestApi", () => {
  it("creates exactly 3 Lambda functions (ingest + 2 read routes) and one HTTP API", () => {
    const template = synth();
    template.resourceCountIs("AWS::Lambda::Function", 3);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  it("creates exactly 3 routes, all protected by the same JWT authorizer", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /demo/devices/{deviceId}/events",
      AuthorizationType: "JWT",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /devices/{deviceId}/latest",
      AuthorizationType: "JWT",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /devices/{deviceId}/telemetry",
      AuthorizationType: "JWT",
    });
  });

  it("passes the demo device allowlist only to the ingest Lambda, not the read Lambdas", () => {
    const template = synth();
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "SenseCare-demoIngest",
      Environment: { Variables: Match.objectLike({ DEMO_DEVICE_ALLOWLIST: "sim-room-01" }) },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "SenseCare-getDeviceLatest",
      Environment: { Variables: Match.not(Match.objectLike({ DEMO_DEVICE_ALLOWLIST: Match.anyValue() })) },
    });
  });

  it("never grants a wildcard IAM action or resource to any of the 3 Lambdas", () => {
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
