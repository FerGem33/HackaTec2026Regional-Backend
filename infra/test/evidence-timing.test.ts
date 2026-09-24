import { App, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as events from "aws-cdk-lib/aws-events";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EvidenceCallbackQueues } from "../lib/constructs/evidence-callback-queues.js";
import { EvidenceCallbackHandlers } from "../lib/constructs/evidence-callback-handlers.js";
import { CaseOrchestration } from "../lib/constructs/case-orchestration.js";

interface AslState {
  Type: string;
  TimeoutSeconds?: number;
}

interface StateMachineDefinition {
  States: Record<string, AslState>;
}

/**
 * Mismo truco que en case-orchestration.test.ts: DefinitionString se
 * sintetiza como Fn::Join por los ARNs dinamicos de Lambda; concatenar solo
 * las partes de tipo string basta para leer TimeoutSeconds (literal).
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

/**
 * Instancia las 3 construcciones involucradas en la relacion temporal del
 * tramo de evidencia en un solo stack, para leer los 3 numeros reales
 * sintetizados (nunca constantes duplicadas a mano) y verificar que siguen
 * siendo compatibles entre si.
 */
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
  const anomalyCasesTable = new dynamodb.Table(stack, "AnomalyCasesTable", {
    partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
  });
  const openCaseLocksTable = new dynamodb.Table(stack, "OpenCaseLocksTable", {
    partitionKey: { name: "lockKey", type: dynamodb.AttributeType.STRING },
  });
  const devicesTable = new dynamodb.Table(stack, "DevicesTable", {
    partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
  });
  const evidenceBucket = new s3.Bucket(stack, "EvidenceBucket");
  const eventBus = new events.EventBus(stack, "Bus", { eventBusName: "SenseCare" });

  const queues = new EvidenceCallbackQueues(stack, "Queues");
  new EvidenceCallbackHandlers(stack, "Handlers", {
    commandAcksQueue: queues.commandAcks.queue,
    evidenceQueue: queues.evidence.queue,
    evidenceCallbacksTable,
    eventLogTable,
    evidenceBucket,
  });
  new CaseOrchestration(stack, "CaseOrchestration", {
    eventBus,
    openCaseLocksTable,
    anomalyCasesTable,
    devicesTable,
    evidenceCallbacksTable,
    eventLogTable,
    evidenceBucket,
  });

  return Template.fromStack(stack);
}

describe("Evidence timing relationships", () => {
  it("keeps both callback queues' visibilityTimeout strictly above their consumer Lambdas' timeout", () => {
    const template = synth();

    const queueTimeouts = Object.values(template.findResources("AWS::SQS::Queue"))
      .map((q) => (q as { Properties: { VisibilityTimeout?: number } }).Properties.VisibilityTimeout)
      .filter((t): t is number => typeof t === "number");
    expect(queueTimeouts).toHaveLength(2); // las 2 colas principales, no las DLQ (sin VisibilityTimeout propio en este stack)

    const handlerFunctionNames = ["SenseCare-commandAckHandler", "SenseCare-evidenceCallbackHandler"];
    const lambdaTimeouts = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((f) => f as { Properties: { FunctionName?: string; Timeout?: number } })
      .filter((f) => handlerFunctionNames.includes(f.Properties.FunctionName ?? ""))
      .map((f) => f.Properties.Timeout);
    expect(lambdaTimeouts).toHaveLength(2);

    for (const visibilityTimeout of queueTimeouts) {
      for (const lambdaTimeout of lambdaTimeouts) {
        expect(lambdaTimeout).toBeDefined();
        expect(visibilityTimeout).toBeGreaterThan(lambdaTimeout as number);
      }
    }
  });

  it("gives at least 3 full SQS delivery attempts room to complete before RequestEvidenceUpload's Step Functions timeout", () => {
    const template = synth();

    const [visibilityTimeout] = Object.values(template.findResources("AWS::SQS::Queue"))
      .map((q) => (q as { Properties: { VisibilityTimeout?: number } }).Properties.VisibilityTimeout)
      .filter((t): t is number => typeof t === "number");
    const [maxReceiveCount] = Object.values(template.findResources("AWS::SQS::Queue"))
      .map(
        (q) =>
          (q as { Properties: { RedrivePolicy?: { maxReceiveCount?: number } } }).Properties.RedrivePolicy
            ?.maxReceiveCount,
      )
      .filter((c): c is number => typeof c === "number");

    const definition = parseStateMachineDefinition(template);
    const sfnTimeoutSeconds = definition.States.RequestEvidenceUpload?.TimeoutSeconds;
    expect(sfnTimeoutSeconds).toBeDefined();

    // maxReceiveCount debe permitir al menos 3 intentos totales...
    expect(maxReceiveCount).toBeGreaterThanOrEqual(3);
    // ...y esos 3 intentos (2 huecos de visibilityTimeout entre ellos) deben
    // caber dentro del tiempo que Step Functions espera antes de tomar el
    // timeout por su cuenta, para que un fallo transitorio (p. ej.
    // throttling de DynamoDB) tenga margen real de resolverse a tiempo.
    const timeForThreeAttempts = 2 * visibilityTimeout;
    expect(timeForThreeAttempts).toBeLessThanOrEqual(sfnTimeoutSeconds as number);
  });

  it("keeps the presigned upload URL / UPLOAD_EVIDENCE command expiry at ~60s", () => {
    const template = synth();
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "SenseCare-requestEvidenceUpload",
      Environment: {
        Variables: {
          EVIDENCE_UPLOAD_TIMEOUT_SECONDS: "60",
        },
      },
    });
  });
});
