import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import * as path from "node:path";

export interface CaseOrchestrationProps {
  eventBus: events.IEventBus;
  openCaseLocksTable: dynamodb.ITable;
  anomalyCasesTable: dynamodb.ITable;
  openCaseLockTtlSeconds?: number;
}

// Resuelto desde __dirname (no process.cwd()): estable sin importar desde
// que directorio se invoque `cdk`/`npm test` (misma correccion aplicada a
// ingestion-functions.ts en Hito 2).
const SERVICE_ENTRY_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "services",
  "orchestration",
  "src",
);

/**
 * Hito 4, primer tramo: EventBridge -> Step Functions Standard por
 * caseId. No incluye Bedrock, S3/evidencia, SNS, Connect, Cognito, API
 * Gateway ni frontend. El flujo solo registra el inicio del caso, crea o
 * actualiza AnomalyCases, renueva OpenCaseLocks una vez y termina.
 *
 * Sin CloudWatch Logs en la State Machine (decision explicita de esta
 * ola). Sin waitForTaskToken: cero tokens de Step Functions expuestos
 * fuera de AWS en este hito.
 */
export class CaseOrchestration extends Construct {
  public readonly stateMachine: sfn.StateMachine;
  public readonly caseDispatcherFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: CaseOrchestrationProps) {
    super(scope, id);

    // Sin reservedConcurrentExecutions: ver ingestion-functions.ts para el
    // porque (la cuenta debe conservar al menos 10 ejecuciones Lambda no
    // reservadas; reservar en las 6 Lambdas de SenseCare lo violaba).
    const commonFnProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
      handler: "handler",
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

    // --- Task Lambdas (invocadas por Step Functions, no por SQS/IoT) ---

    const taskEnvironment = {
      OPEN_CASE_LOCKS_TABLE_NAME: props.openCaseLocksTable.tableName,
      ANOMALY_CASES_TABLE_NAME: props.anomalyCasesTable.tableName,
      OPEN_CASE_LOCK_TTL_SECONDS: String(props.openCaseLockTtlSeconds ?? 7200),
    };

    const renewOpenCaseLockFn = new lambdaNodejs.NodejsFunction(this, "RenewOpenCaseLockFn", {
      ...commonFnProps,
      functionName: "SenseCare-renewOpenCaseLock",
      entry: path.join(SERVICE_ENTRY_ROOT, "renewOpenCaseLockFn.ts"),
      environment: taskEnvironment,
    });
    props.openCaseLocksTable.grant(renewOpenCaseLockFn, "dynamodb:UpdateItem");

    const upsertAnomalyCaseFn = new lambdaNodejs.NodejsFunction(this, "UpsertAnomalyCaseFn", {
      ...commonFnProps,
      functionName: "SenseCare-upsertAnomalyCase",
      entry: path.join(SERVICE_ENTRY_ROOT, "upsertAnomalyCaseFn.ts"),
      environment: taskEnvironment,
    });
    props.anomalyCasesTable.grant(upsertAnomalyCaseFn, "dynamodb:PutItem", "dynamodb:UpdateItem");

    // --- State Machine ---
    // Cada Task recibe { caseDetail: $, executionArn: $$.Execution.Id } y
    // descarta su propio resultado (JsonPath.DISCARD), asi que "$" nunca
    // cambia entre estados: ambas tasks ven exactamente el mismo detalle
    // de anomalia con el que arranco la ejecucion.
    const taskPayload = sfn.TaskInput.fromObject({
      "caseDetail.$": "$",
      "executionArn.$": "$$.Execution.Id",
    });

    const caseRegistrationFailed = new sfn.Fail(this, "CaseRegistrationFailed", {
      error: "CaseRegistrationFailed",
      cause: "No se pudo registrar/renovar el caso; revisar CloudWatch Logs y EventLog.",
    });

    const renewLockTask = new tasks.LambdaInvoke(this, "RenewOpenCaseLock", {
      lambdaFunction: renewOpenCaseLockFn,
      payload: taskPayload,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
      // Retry explicito para errores transitorios del servicio Lambda
      // (throttling, timeouts de invocacion del propio Lambda, etc.):
      // Lambda.ServiceException / AWSLambdaException / SdkClientException /
      // ClientExecutionTimeoutException, 2s de intervalo, backoff x2, 6
      // intentos maximos. Ver
      // https://docs.aws.amazon.com/step-functions/latest/dg/bp-lambda-serviceexception.html
      retryOnServiceExceptions: true,
    });
    renewLockTask.addCatch(caseRegistrationFailed, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.error",
    });

    const upsertCaseTask = new tasks.LambdaInvoke(this, "UpsertAnomalyCase", {
      lambdaFunction: upsertAnomalyCaseFn,
      payload: taskPayload,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    upsertCaseTask.addCatch(caseRegistrationFailed, {
      errors: [sfn.Errors.ALL],
      resultPath: "$.error",
    });

    const caseRegistered = new sfn.Succeed(this, "CaseRegistered");

    const definition = renewLockTask.next(upsertCaseTask).next(caseRegistered);

    this.stateMachine = new sfn.StateMachine(this, "SenseCareCaseStateMachine", {
      stateMachineName: "SenseCare-CaseStateMachine",
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
    });

    // --- Dispatcher Lambda (target de EventBridge) ---
    // No hay forma de fijar un nombre de ejecucion determinista desde un
    // target nativo de EventBridge hacia Step Functions (verificado contra
    // aws-events-targets.SfnStateMachineProps: solo expone input/role), por
    // eso el target es esta Lambda, que llama StartExecution ella misma.
    this.caseDispatcherFn = new lambdaNodejs.NodejsFunction(this, "CaseDispatcherFn", {
      ...commonFnProps,
      functionName: "SenseCare-caseDispatcher",
      entry: path.join(SERVICE_ENTRY_ROOT, "caseDispatcherFn.ts"),
      environment: {
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
      },
    });
    this.stateMachine.grantStartExecution(this.caseDispatcherFn);

    const dispatcherDlq = new sqs.Queue(this, "CaseDispatcherDlq", {
      queueName: "SenseCare-case-dispatcher-dlq",
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    new events.Rule(this, "AnomalyDetectedRule", {
      ruleName: "SenseCare-AnomalyDetected",
      eventBus: props.eventBus,
      eventPattern: {
        source: ["SenseCare"],
        detailType: ["anomaly.detected"],
      },
      targets: [
        new targets.LambdaFunction(this.caseDispatcherFn, {
          deadLetterQueue: dispatcherDlq,
          retryAttempts: 3,
        }),
      ],
    });
  }
}
