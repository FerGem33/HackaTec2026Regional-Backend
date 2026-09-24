import { App, Stack } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { PushDevicesApi } from "../lib/constructs/push-devices-api.js";

const PINPOINT_APPLICATION_ID = "abc123def456";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");

  const httpApi = new apigwv2.HttpApi(stack, "HttpApi");
  const authorizer = new HttpJwtAuthorizer("TestAuthorizer", "https://cognito-idp.us-east-1.amazonaws.com/pool", {
    jwtAudience: ["client-id"],
  });
  const caregiverPushEndpointsTable = new dynamodb.Table(stack, "CaregiverPushEndpointsTable", {
    partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "endpointId", type: dynamodb.AttributeType.STRING },
  });

  new PushDevicesApi(stack, "PushDevicesApi", {
    httpApi,
    authorizer,
    caregiverPushEndpointsTable,
    pinpointApplicationId: PINPOINT_APPLICATION_ID,
  });

  return Template.fromStack(stack);
}

describe("PushDevicesApi", () => {
  it("creates exactly 2 Lambda functions and no new API Gateway (reuses the one passed in)", () => {
    const template = synth();
    template.resourceCountIs("AWS::Lambda::Function", 2);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  it("creates exactly the 2 routes protected by the SAME authorizer instance passed in", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
    for (const routeKey of ["POST /me/push-devices", "DELETE /me/push-devices/{endpointId}"]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "JWT",
      });
    }
  });

  it("scopes mobiletargeting:UpdateEndpoint/DeleteEndpoint to this app's endpoints only, never mobiletargeting:* or another app", () => {
    const template = synth();
    const policies = Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
      Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
    }>;

    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const pinpointStatements = statements.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a) => typeof a === "string" && a.startsWith("mobiletargeting:"));
    });

    expect(pinpointStatements.length).toBeGreaterThanOrEqual(2);
    for (const statement of pinpointStatements) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      expect(actions).not.toContain("mobiletargeting:*");
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      for (const resource of resources) {
        // El ARN se compone en runtime con cdk.Aws.REGION/ACCOUNT_ID, asi que
        // el template lo sintetiza como un intrinsico Fn::Join, no un string
        // plano -- se verifica su contenido serializado en vez de igualdad.
        expect(JSON.stringify(resource)).toContain(`apps/${PINPOINT_APPLICATION_ID}/endpoints/`);
      }
    }
  });

  it("never grants SNS, S3, Bedrock, Connect, or dynamodb:* to either Lambda", () => {
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
        expect(actionsJson).not.toContain("sns:");
        expect(actionsJson).not.toContain("s3:");
        expect(actionsJson).not.toContain("bedrock:");
        expect(actionsJson).not.toContain("connect:");
        expect(actionsJson).not.toContain("dynamodb:*");
      }
    }
  });
});
