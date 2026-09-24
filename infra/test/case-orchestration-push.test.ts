import { App, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as kms from "aws-cdk-lib/aws-kms";
import * as events from "aws-cdk-lib/aws-events";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CaseOrchestration } from "../lib/constructs/case-orchestration.js";

/**
 * Cubre unicamente el tramo condicional de push (props.pushNotifications)
 * de CaseOrchestration: infra/test/case-orchestration.test.ts (sin ese
 * prop) ya prueba exhaustivamente el resto de la maquina de estados y
 * confirma que, SIN este prop, el comportamiento es identico al de antes
 * de este hito. Archivo separado a proposito: mantiene ese archivo (lento,
 * 24 tests x varios lambdas) enfocado, y este enfocado en la parte nueva.
 */

const TEST_BEDROCK_MODEL_ID = "us.amazon.nova-lite-v1:0";
const TEST_BEDROCK_INFERENCE_PROFILE_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-lite-v1:0";
const TEST_BEDROCK_FOUNDATION_MODEL_ARNS = [
  "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0",
];
const PINPOINT_APPLICATION_ID = "abc123def456";

interface AslState {
  Type: string;
  Next?: string;
  Catch?: Array<{ ErrorEquals: string[]; Next: string }>;
}

interface StateMachineDefinition {
  StartAt: string;
  States: Record<string, AslState>;
}

function parseStateMachineDefinition(template: Template): StateMachineDefinition {
  const machines = template.findResources("AWS::StepFunctions::StateMachine");
  const [machine] = Object.values(machines) as Array<{
    Properties: { DefinitionString: { "Fn::Join": [string, unknown[]] } };
  }>;
  const parts = machine.Properties.DefinitionString["Fn::Join"][1];
  const literalOnly = parts.filter((p): p is string => typeof p === "string").join("");
  return JSON.parse(literalOnly) as StateMachineDefinition;
}

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  const openCaseLocksTable = new dynamodb.Table(stack, "OpenCaseLocksTable", {
    partitionKey: { name: "lockKey", type: dynamodb.AttributeType.STRING },
  });
  const anomalyCasesTable = new dynamodb.Table(stack, "AnomalyCasesTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
  });
  const devicesTable = new dynamodb.Table(stack, "DevicesTable", {
    partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
  });
  const evidenceCallbacksTable = new dynamodb.Table(stack, "EvidenceCallbacksTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "callbackType", type: dynamodb.AttributeType.STRING },
  });
  const eventLogTable = new dynamodb.Table(stack, "EventLogTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "occurredAtEventId", type: dynamodb.AttributeType.STRING },
  });
  const evidenceBucket = new s3.Bucket(stack, "EvidenceBucket");
  const observationsTable = new dynamodb.Table(stack, "ObservationsTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "imageId", type: dynamodb.AttributeType.STRING },
  });
  const eventBus = new events.EventBus(stack, "Bus", { eventBusName: "SenseCare" });
  const alertsTable = new dynamodb.Table(stack, "AlertsTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
  });
  const caregiverAccessTable = new dynamodb.Table(stack, "CaregiverAccessTable", {
    partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
  });
  caregiverAccessTable.addGlobalSecondaryIndex({
    indexName: "CaregiverAccessByDevice",
    partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
  });
  const alertsTopic = new sns.Topic(stack, "AlertsTopic");
  const caregiverPushEndpointsTable = new dynamodb.Table(stack, "CaregiverPushEndpointsTable", {
    partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "endpointId", type: dynamodb.AttributeType.STRING },
  });
  const alertDeliveriesTable = new dynamodb.Table(stack, "AlertDeliveriesTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "deliveryId", type: dynamodb.AttributeType.STRING },
  });
  const caseActionCallbacksTable = new dynamodb.Table(stack, "CaseActionCallbacksTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "callbackType", type: dynamodb.AttributeType.STRING },
  });
  const fallbackCallCmk = new kms.Key(stack, "FallbackCallDestinationKey");

  new CaseOrchestration(stack, "CaseOrchestration", {
    eventBus,
    openCaseLocksTable,
    anomalyCasesTable,
    devicesTable,
    evidenceCallbacksTable,
    eventLogTable,
    evidenceBucket,
    observationsTable,
    bedrockModelId: TEST_BEDROCK_MODEL_ID,
    bedrockInferenceProfileArn: TEST_BEDROCK_INFERENCE_PROFILE_ARN,
    bedrockFoundationModelArns: TEST_BEDROCK_FOUNDATION_MODEL_ARNS,
    alertsTable,
    caregiverAccessTable,
    alertsTopic,
    pushNotifications: {
      caregiverPushEndpointsTable,
      alertDeliveriesTable,
      pinpointApplicationId: PINPOINT_APPLICATION_ID,
    },
    // Hito de escalamiento: valores ficticios explicitos, mismo patron que
    // infra/test/case-orchestration.test.ts (no probado a fondo aqui, este
    // archivo solo cubre el tramo de push).
    caseActionCallbacksTable,
    fallbackCallCmk,
    fallbackCallDestinationParameterName: "/sensecare/demo/fallback-call-destination-test",
    fallbackCallDestinationParameterArn:
      "arn:aws:ssm:us-east-1:123456789012:parameter/sensecare/demo/fallback-call-destination-test",
    connectInstanceId: "11111111-1111-1111-1111-111111111111",
    connectContactFlowId: "22222222-2222-2222-2222-222222222222",
    connectSourcePhoneNumber: "+10000000000",
    escalationAllowedDeviceIds: ["pi-demo-01", "sim-room-01"],
  });

  return Template.fromStack(stack);
}

describe("CaseOrchestration with pushNotifications", () => {
  it("creates exactly 15 Lambdas (the 10 push-era Lambdas plus 5 escalation Lambdas)", () => {
    const template = synth();
    template.resourceCountIs("AWS::Lambda::Function", 15);
    template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "SenseCare-dispatchPush" });
  });

  it("inserts DispatchPushImmediate right after DispatchAlertImmediate, still converging on PrepareEvidencePhase", () => {
    const definition = parseStateMachineDefinition(synth());
    const dispatchAlertImmediate = definition.States.DispatchAlertImmediate;
    expect(dispatchAlertImmediate?.Next).toBe("DispatchPushImmediate");

    const dispatchPushImmediate = definition.States.DispatchPushImmediate;
    expect(dispatchPushImmediate?.Next).toBe("PrepareEvidencePhase");
    expect(dispatchPushImmediate?.Catch?.[0]).toMatchObject({
      ErrorEquals: ["States.ALL"],
      Next: "PrepareEvidencePhase",
    });
  });

  it("inserts DispatchPushIfNotAlready right after NotifyCaregiversIfNotAlready, still converging on RequestHumanDecision (hito de escalamiento)", () => {
    const definition = parseStateMachineDefinition(synth());
    const notifyCaregivers = definition.States.NotifyCaregiversIfNotAlready;
    expect(notifyCaregivers?.Next).toBe("DispatchPushIfNotAlready");

    const dispatchPushIfNotAlready = definition.States.DispatchPushIfNotAlready;
    expect(dispatchPushIfNotAlready?.Next).toBe("RequestHumanDecision");
    expect(dispatchPushIfNotAlready?.Catch?.[0]).toMatchObject({
      ErrorEquals: ["States.ALL"],
      Next: "RequestHumanDecision",
    });
  });

  it("scopes mobiletargeting:SendMessages to the exact Pinpoint app, never a wildcard", () => {
    const template = synth();
    const policies = Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
      Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
    }>;
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const sendMessagesStatements = statements.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("mobiletargeting:SendMessages");
    });

    expect(sendMessagesStatements.length).toBeGreaterThanOrEqual(1);
    for (const statement of sendMessagesStatements) {
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      for (const resource of resources) {
        expect(JSON.stringify(resource)).toContain(`apps/${PINPOINT_APPLICATION_ID}`);
      }
    }
  });
});
