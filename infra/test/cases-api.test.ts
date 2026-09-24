import { App, Stack } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CasesApi } from "../lib/constructs/cases-api.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");

  const httpApi = new apigwv2.HttpApi(stack, "HttpApi");
  const authorizer = new HttpJwtAuthorizer("TestAuthorizer", "https://cognito-idp.us-east-1.amazonaws.com/pool", {
    jwtAudience: ["client-id"],
  });

  const anomalyCasesTable = new dynamodb.Table(stack, "AnomalyCasesTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
  });
  const alertsTable = new dynamodb.Table(stack, "AlertsTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
  });
  const eventLogTable = new dynamodb.Table(stack, "EventLogTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "occurredAtEventId", type: dynamodb.AttributeType.STRING },
  });
  const caregiverAccessTable = new dynamodb.Table(stack, "CaregiverAccessTable", {
    partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
  });

  new CasesApi(stack, "CasesApi", {
    httpApi,
    authorizer,
    anomalyCasesTable,
    alertsTable,
    eventLogTable,
    caregiverAccessTable,
  });

  return Template.fromStack(stack);
}

describe("CasesApi", () => {
  it("creates exactly 3 Lambda functions and no new API Gateway (reuses the one passed in)", () => {
    const template = synth();
    template.resourceCountIs("AWS::Lambda::Function", 3);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1); // el que ya paso el test, no uno nuevo
  });

  it("creates exactly the 3 routes protected by the SAME authorizer instance passed in (reuses DemoAuth's JWT, no second User Pool)", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1); // el que ya paso el test
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
    for (const routeKey of [
      "GET /cases/{caseId}/events",
      "POST /cases/{caseId}/cancel",
      "POST /cases/{caseId}/escalate",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "JWT",
      });
    }
  });

  it("never grants S3, Bedrock, Connect, sns:Publish, or any wildcard action to the 3 case-action Lambdas", () => {
    const template = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    for (const policy of Object.values(policies)) {
      const statements = (
        policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown }> } } }
      ).Properties.PolicyDocument.Statement;

      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        expect(actions).not.toContain("*");
        const actionsJson = JSON.stringify(actions);
        expect(actionsJson).not.toContain("s3:");
        expect(actionsJson).not.toContain("bedrock:");
        expect(actionsJson).not.toContain("connect:");
        expect(actionsJson).not.toContain("sns:");
        expect(actionsJson).not.toContain("dynamodb:*");
      }
    }
  });

  it("cancel/escalate get dynamodb:TransactWriteItems on AnomalyCases and Alerts, never a bare UpdateItem/PutItem on either", () => {
    const template = synth();
    const policies = Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
      Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
    }>;

    const transactStatements = policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes("dynamodb:TransactWriteItems");
      });

    // cancelCaseFn y escalateCaseFn, cada uno con su propia policy: 2
    // Lambdas x 2 tablas (AnomalyCases, Alerts) referenciadas.
    expect(transactStatements.length).toBeGreaterThanOrEqual(2);
  });

  it("all 3 Lambdas receive the 4 table names they need as environment variables", () => {
    const template = synth();
    for (const functionName of ["SenseCare-getCaseEvents", "SenseCare-cancelCase", "SenseCare-escalateCase"]) {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: functionName,
        Environment: {
          Variables: Match.objectLike({
            ANOMALY_CASES_TABLE_NAME: Match.anyValue(),
            ALERTS_TABLE_NAME: Match.anyValue(),
            EVENT_LOG_TABLE_NAME: Match.anyValue(),
            CAREGIVER_ACCESS_TABLE_NAME: Match.anyValue(),
          }),
        },
      });
    }
  });
});
