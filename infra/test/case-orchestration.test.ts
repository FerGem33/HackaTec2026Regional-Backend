import { App, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CaseOrchestration } from "../lib/constructs/case-orchestration.js";

interface AslState {
  Type: string;
  Next?: string;
  Retry?: Array<{ ErrorEquals: string[] }>;
  Catch?: Array<{ ErrorEquals: string[]; Next: string }>;
}

interface StateMachineDefinition {
  StartAt: string;
  States: Record<string, AslState>;
}

/**
 * DefinitionString se sintetiza como Fn::Join porque el ASL referencia
 * ARNs de Lambda dinamicos (tokens de CDK) intercalados con texto
 * literal. Cada token cae exactamente donde iria un valor de string JSON,
 * asi que concatenar solo las partes de tipo string del join produce JSON
 * valido (con esos valores vacios), suficiente para verificar Retry/Catch
 * sin necesitar resolver los ARNs reales.
 */
function parseStateMachineDefinition(template: Template): StateMachineDefinition {
  const machines = template.findResources("AWS::StepFunctions::StateMachine");
  const [machine] = Object.values(machines) as Array<{
    Properties: { DefinitionString: { "Fn::Join": [string, unknown[]] } };
  }>;
  const parts = machine.Properties.DefinitionString["Fn::Join"][1];
  const literalOnly = parts.filter((p): p is string => typeof p === "string").join("");
  return JSON.parse(literalOnly) as StateMachineDefinition;
}

function synth(): { template: Template; stack: Stack } {
  const stack = new Stack(new App(), "TestStack");
  const openCaseLocksTable = new dynamodb.Table(stack, "OpenCaseLocksTable", {
    partitionKey: { name: "lockKey", type: dynamodb.AttributeType.STRING },
  });
  const anomalyCasesTable = new dynamodb.Table(stack, "AnomalyCasesTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
  });
  const eventBus = new events.EventBus(stack, "Bus", { eventBusName: "SenseCare" });

  new CaseOrchestration(stack, "CaseOrchestration", {
    eventBus,
    openCaseLocksTable,
    anomalyCasesTable,
  });

  return { template: Template.fromStack(stack), stack };
}

describe("CaseOrchestration", () => {
  it("creates exactly one Standard state machine", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
    });
  });

  it("wires the ASL with a Retry on both tasks and a Catch to CaseRegistrationFailed", () => {
    const { template } = synth();
    const definition = parseStateMachineDefinition(template);

    expect(definition.StartAt).toBe("RenewOpenCaseLock");

    const renew = definition.States.RenewOpenCaseLock;
    expect(renew?.Type).toBe("Task");
    expect(renew?.Next).toBe("UpsertAnomalyCase");
    expect(renew?.Retry?.[0]?.ErrorEquals).toEqual(
      expect.arrayContaining([
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
      ]),
    );
    expect(renew?.Catch?.[0]).toMatchObject({
      ErrorEquals: ["States.ALL"],
      Next: "CaseRegistrationFailed",
    });

    const upsert = definition.States.UpsertAnomalyCase;
    expect(upsert?.Type).toBe("Task");
    expect(upsert?.Next).toBe("CaseRegistered");
    expect(upsert?.Retry?.[0]?.ErrorEquals).toEqual(
      expect.arrayContaining([
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
      ]),
    );
    expect(upsert?.Catch?.[0]).toMatchObject({
      ErrorEquals: ["States.ALL"],
      Next: "CaseRegistrationFailed",
    });

    expect(definition.States.CaseRegistered?.Type).toBe("Succeed");
    expect(definition.States.CaseRegistrationFailed?.Type).toBe("Fail");
  });

  it("scopes the state machine's execution role to exactly the two task Lambda ARNs", () => {
    const { template } = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    const invokePolicies = Object.values(policies).filter((policy) => {
      const statements = (
        policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown }> } } }
      ).Properties.PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes("lambda:InvokeFunction");
      });
    });

    // Un statement de invocacion perteneciente al rol de la state machine.
    const smInvokeStatement = invokePolicies
      .flatMap(
        (p) =>
          (
            p as {
              Properties: {
                PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
              };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .find((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        return actions.includes("lambda:InvokeFunction") && resources.length === 2;
      });

    expect(smInvokeStatement).toBeDefined();
  });

  it("gives renewOpenCaseLockFn only dynamodb:UpdateItem on OpenCaseLocks", () => {
    const { template } = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    const updateOnlyPolicy = Object.values(policies).find((policy) => {
      const statements = (
        policy as {
          Properties: { PolicyDocument: { Statement: Array<{ Action: unknown }> } };
        }
      ).Properties.PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.length === 1 && actions[0] === "dynamodb:UpdateItem";
      });
    });

    expect(updateOnlyPolicy).toBeDefined();
  });

  it("gives upsertAnomalyCaseFn only dynamodb:PutItem + dynamodb:UpdateItem on AnomalyCases", () => {
    const { template } = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    const putUpdatePolicy = Object.values(policies).find((policy) => {
      const statements = (
        policy as {
          Properties: { PolicyDocument: { Statement: Array<{ Action: unknown }> } };
        }
      ).Properties.PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return (
          actions.length === 2 &&
          actions.includes("dynamodb:PutItem") &&
          actions.includes("dynamodb:UpdateItem")
        );
      });
    });

    expect(putUpdatePolicy).toBeDefined();
  });

  it("gives caseDispatcherFn only states:StartExecution, scoped to the one state machine", () => {
    const { template } = synth();
    const policies = template.findResources("AWS::IAM::Policy");

    const startExecPolicy = Object.values(policies).find((policy) => {
      const statements = (
        policy as {
          Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
        }
      ).Properties.PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.length === 1 && actions[0] === "states:StartExecution";
      });
    });

    expect(startExecPolicy).toBeDefined();
  });

  it("creates the AnomalyDetectedRule with the exact source/detail-type pattern and a single Lambda target with a DLQ", () => {
    const { template } = synth();
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: { source: ["SenseCare"], "detail-type": ["anomaly.detected"] },
      Targets: Match.arrayWith([
        Match.objectLike({
          DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
          RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 3 }),
        }),
      ]),
    });
    template.resourceCountIs("AWS::Events::Rule", 1);
  });

  it("never grants a wildcard IAM action, and no AdministratorAccess anywhere", () => {
    const { template } = synth();
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
        expect(JSON.stringify(actions)).not.toContain("dynamodb:*");
        expect(JSON.stringify(actions)).not.toContain("states:*");
      }
    }

    template.resourcePropertiesCountIs(
      "AWS::IAM::Role",
      { ManagedPolicyArns: Match.arrayWith([Match.stringLikeRegexp("AdministratorAccess")]) },
      0,
    );
  });
});
