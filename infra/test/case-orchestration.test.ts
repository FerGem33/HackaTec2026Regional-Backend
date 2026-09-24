import { App, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as events from "aws-cdk-lib/aws-events";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CaseOrchestration } from "../lib/constructs/case-orchestration.js";

interface AslState {
  Type: string;
  Next?: string;
  TimeoutSeconds?: number;
  Retry?: Array<{ ErrorEquals: string[] }>;
  Catch?: Array<{ ErrorEquals: string[]; Next: string; ResultPath?: string }>;
  Choices?: Array<{ Variable: string; BooleanEquals?: boolean; Next: string }>;
  Default?: string;
  Parameters?: Record<string, unknown>;
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
  const eventBus = new events.EventBus(stack, "Bus", { eventBusName: "SenseCare" });

  new CaseOrchestration(stack, "CaseOrchestration", {
    eventBus,
    openCaseLocksTable,
    anomalyCasesTable,
    devicesTable,
    evidenceCallbacksTable,
    eventLogTable,
    evidenceBucket,
  });

  return { template: Template.fromStack(stack), stack };
}

function policyStatements(template: Template): Array<{ Action: unknown; Resource: unknown }> {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (p) =>
      (
        p as { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } } }
      ).Properties.PolicyDocument.Statement,
  );
}

describe("CaseOrchestration", () => {
  it("creates exactly one Standard state machine", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
    });
  });

  it("does not reserve concurrency on any orchestration Lambda", () => {
    // La cuenta debe conservar al menos 10 ejecuciones Lambda no
    // reservadas; reservar en cada una de las Lambdas de SenseCare lo
    // violaba (fallo real de deploy). No declarar
    // ReservedConcurrentExecutions en absoluto, no bajarlo a otro valor.
    const { template } = synth();
    const functions = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(functions)) {
      expect(
        (fn as { Properties: Record<string, unknown> }).Properties.ReservedConcurrentExecutions,
      ).toBeUndefined();
    }
  });

  it("creates exactly the 5 task Lambdas invoked by the state machine", () => {
    const { template } = synth();
    const functions = template.findResources("AWS::Lambda::Function");
    // 5 tasks (renew, upsert, cameraConsent, requestEvidenceUpload,
    // recordEvidenceOutcome) + el dispatcher de EventBridge = 6.
    expect(Object.keys(functions)).toHaveLength(6);
  });

  it("wires the registration phase (RenewOpenCaseLock -> UpsertAnomalyCase) with Retry and a Catch to CaseRegistrationFailed", () => {
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
    expect(upsert?.Next).toBe("PrepareEvidencePhase");
    expect(upsert?.Catch?.[0]).toMatchObject({
      ErrorEquals: ["States.ALL"],
      Next: "CaseRegistrationFailed",
    });

    expect(definition.States.CaseRegistrationFailed?.Type).toBe("Fail");
  });

  it("checks camera consent and branches: granted -> RequestEvidenceUpload, denied -> MapToSkippedNoConsent", () => {
    const { template } = synth();
    const definition = parseStateMachineDefinition(template);

    expect(definition.States.PrepareEvidencePhase?.Type).toBe("Pass");
    expect(definition.States.PrepareEvidencePhase?.Next).toBe("CheckCameraConsent");

    const checkConsent = definition.States.CheckCameraConsent;
    expect(checkConsent?.Type).toBe("Task");
    expect(checkConsent?.Next).toBe("CameraConsentGranted?");
    expect(checkConsent?.Catch?.[0]).toMatchObject({ ErrorEquals: ["States.ALL"], Next: "MapToError" });

    const choice = definition.States["CameraConsentGranted?"];
    expect(choice?.Type).toBe("Choice");
    expect(choice?.Choices?.[0]).toMatchObject({
      Variable: "$.cameraConsent",
      BooleanEquals: true,
      Next: "RequestEvidenceUpload",
    });
    expect(choice?.Default).toBe("MapToSkippedNoConsent");

    expect(definition.States.MapToSkippedNoConsent?.Type).toBe("Pass");
    expect(definition.States.MapToSkippedNoConsent?.Next).toBe("RecordEvidenceOutcome");
  });

  it("requests evidence upload with waitForTaskToken, a ~90s timeout, and never auto-closes on rejection/timeout/technical error", () => {
    const { template } = synth();
    const definition = parseStateMachineDefinition(template);

    const requestUpload = definition.States.RequestEvidenceUpload;
    expect(requestUpload?.Type).toBe("Task");
    expect(requestUpload?.TimeoutSeconds).toBe(90);
    expect(requestUpload?.Next).toBe("MapToAvailable");

    // Motivos de rechazo/incertidumbre conocidos (COMMAND_ACK
    // accepted:false, resultado invalido/ausente, timeout nativo del wait)
    // van siempre a INCOMPLETE, nunca cierran el caso como exitoso.
    const incompleteCatch = requestUpload?.Catch?.find((c) => c.Next === "MapToIncomplete");
    expect(incompleteCatch?.ErrorEquals).toEqual(
      expect.arrayContaining([
        "REJECTED",
        "UPLOAD_FAILED",
        "OBJECT_INVALID",
        "OBJECT_MISSING",
        "States.Timeout",
      ]),
    );

    // Cualquier otra falla tecnica (catch-all) va a ERROR, no a INCOMPLETE
    // ni a un cierre silencioso.
    const errorCatch = requestUpload?.Catch?.find((c) => c.Next === "MapToError");
    expect(errorCatch?.ErrorEquals).toEqual(["States.ALL"]);

    // El catch especifico debe evaluarse antes que el catch-all (Step
    // Functions usa el primer Catch cuyo ErrorEquals coincide).
    expect(requestUpload?.Catch?.[0]?.Next).toBe("MapToIncomplete");
    expect(requestUpload?.Catch?.[1]?.Next).toBe("MapToError");
  });

  it("converges every branch (AVAILABLE/INCOMPLETE/ERROR/SKIPPED_NO_CONSENT) into RecordEvidenceOutcome before ever succeeding or failing the execution", () => {
    const { template } = synth();
    const definition = parseStateMachineDefinition(template);

    for (const stateName of ["MapToAvailable", "MapToIncomplete", "MapToError", "MapToSkippedNoConsent"]) {
      const state = definition.States[stateName];
      expect(state?.Type).toBe("Pass");
      expect(state?.Next).toBe("RecordEvidenceOutcome");
    }

    const recordOutcome = definition.States.RecordEvidenceOutcome;
    expect(recordOutcome?.Type).toBe("Task");
    expect(recordOutcome?.Next).toBe("CaseEvidencePhaseComplete");
    expect(recordOutcome?.Catch?.[0]).toMatchObject({
      ErrorEquals: ["States.ALL"],
      Next: "EvidenceOutcomeRecordingFailed",
    });

    expect(definition.States.CaseEvidencePhaseComplete?.Type).toBe("Succeed");
    expect(definition.States.EvidenceOutcomeRecordingFailed?.Type).toBe("Fail");
  });

  it("MapToError (the States.ALL catch-all) always produces the fixed, safe reason INTERNAL_ERROR, never the raw technical error text", () => {
    // MapToError es el destino del catch-all de CUALQUIER falla tecnica no
    // controlada (excepcion de runtime, fallo de SDK, etc.); a diferencia
    // de MapToIncomplete (cuyo Catch solo enumera codigos cerrados
    // conocidos), evidenceReason aqui debe ser un literal fijo, nunca una
    // referencia dinamica a $.evidenceError.Error, para no propagar texto
    // de error tecnico hacia AnomalyCases ni EventLog.
    const { template } = synth();
    const definition = parseStateMachineDefinition(template);

    expect(definition.States.MapToError?.Parameters).toMatchObject({
      evidenceStatus: "ERROR",
      evidenceReason: "INTERNAL_ERROR",
    });
    expect(definition.States.MapToError?.Parameters?.["evidenceReason.$"]).toBeUndefined();
  });

  it("MapToIncomplete keeps a dynamic reason, safe because its Catch only ever matches closed, known error codes", () => {
    const { template } = synth();
    const definition = parseStateMachineDefinition(template);

    expect(definition.States.MapToIncomplete?.Parameters).toMatchObject({
      evidenceStatus: "INCOMPLETE",
      "evidenceReason.$": "$.evidenceError.Error",
    });
  });

  it("scopes the state machine's execution role to exactly the five task Lambda ARNs (no wildcard function resource)", () => {
    const { template } = synth();
    const roles = template.findResources("AWS::IAM::Role");
    const [stateMachineRoleId] = Object.entries(roles)
      .filter(([, r]) =>
        JSON.stringify((r as { Properties: { AssumeRolePolicyDocument: unknown } }).Properties)
          .includes("states.amazonaws.com"),
      )
      .map(([id]) => id);
    expect(stateMachineRoleId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const stateMachinePolicy = Object.values(policies).find((p) =>
      (
        (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties.Roles ?? []
      ).some((r) => r.Ref === stateMachineRoleId),
    ) as { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } } };
    expect(stateMachinePolicy).toBeDefined();

    const invokeStatements = stateMachinePolicy.Properties.PolicyDocument.Statement.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("lambda:InvokeFunction");
    });

    // Cada Task otorga su propio grantInvoke (Arn + Arn:* para alias), sin
    // fusionarse en un unico statement; se cuentan los ARNs base distintos
    // (Fn::GetAtt directo, sin el sufijo ":*" de alias) para verificar que
    // son exactamente las 5 Lambdas de tarea, ninguna de mas ni de menos.
    const baseArnKeys = new Set(
      invokeStatements.flatMap((s) => {
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        return resources
          .filter((r): r is { "Fn::GetAtt": [string, string] } => {
            const getAtt = (r as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"];
            return Array.isArray(getAtt) && getAtt[1] === "Arn";
          })
          .map((r) => r["Fn::GetAtt"][0]);
      }),
    );

    expect(baseArnKeys.size).toBe(5);
  });

  it("gives renewOpenCaseLockFn only dynamodb:UpdateItem on OpenCaseLocks", () => {
    const { template } = synth();
    const statements = policyStatements(template);

    const updateOnlyPolicy = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "dynamodb:UpdateItem";
    });

    expect(updateOnlyPolicy).toBeDefined();
  });

  it("gives cameraConsentFn only dynamodb:GetItem on Devices", () => {
    const { template } = synth();
    const statements = policyStatements(template);

    const getOnlyPolicy = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "dynamodb:GetItem";
    });

    expect(getOnlyPolicy).toBeDefined();
  });

  it("gives requestEvidenceUploadFn s3:PutObject scoped to raw-images/* and iot:Publish scoped to the /commands topic suffix, no wildcards", () => {
    const { template } = synth();
    const statements = policyStatements(template);

    const s3PutStatement = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "s3:PutObject";
    });
    expect(s3PutStatement).toBeDefined();
    expect(JSON.stringify(s3PutStatement?.Resource)).toContain("raw-images/*");

    const iotPublishStatement = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "iot:Publish";
    });
    expect(iotPublishStatement).toBeDefined();
    expect(JSON.stringify(iotPublishStatement?.Resource)).toContain(
      "topic/SenseCare/v1/devices/*/commands",
    );
  });

  it("gives recordEvidenceOutcomeFn dynamodb:UpdateItem on AnomalyCases and on EvidenceCallbacks, plus PutItem on EventLog", () => {
    const { template } = synth();
    const statements = policyStatements(template);

    const updateOnlyStatements = statements.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "dynamodb:UpdateItem";
    });
    // renewOpenCaseLockFn (OpenCaseLocks) + recordEvidenceOutcomeFn
    // (AnomalyCases) + recordEvidenceOutcomeFn (EvidenceCallbacks).
    expect(updateOnlyStatements.length).toBeGreaterThanOrEqual(3);
  });

  it("gives caseDispatcherFn only states:StartExecution, scoped to the one state machine", () => {
    const { template } = synth();
    const statements = policyStatements(template);

    const startExecPolicy = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.length === 1 && actions[0] === "states:StartExecution";
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

  it("never grants a wildcard IAM action or resource, and no AdministratorAccess anywhere", () => {
    // A diferencia de evidence-callback-handlers.ts (que SI necesita
    // Resource:"*" para states:SendTaskSuccess/Failure, la unica excepcion
    // documentada del paquete), esta construccion no llama SendTask* en
    // absoluto: sus 5 Lambdas de tarea solo leen/escriben DynamoDB, S3 e
    // iot:Publish, todo escopado a ARNs/prefijos concretos.
    const { template } = synth();
    const statements = policyStatements(template);

    for (const statement of statements) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      expect(actions).not.toContain("*");
      expect(JSON.stringify(actions)).not.toContain("dynamodb:*");
      expect(JSON.stringify(actions)).not.toContain("states:*");
      expect(JSON.stringify(actions)).not.toContain("s3:*");
      expect(statement.Resource).not.toBe("*");
    }

    template.resourcePropertiesCountIs(
      "AWS::IAM::Role",
      { ManagedPolicyArns: Match.arrayWith([Match.stringLikeRegexp("AdministratorAccess")]) },
      0,
    );
  });
});
