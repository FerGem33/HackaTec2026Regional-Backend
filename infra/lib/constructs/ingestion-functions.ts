import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "node:path";

export interface IngestionFunctionsProps {
  telemetryQueue: sqs.IQueue;
  visualAnomalyQueue: sqs.IQueue;
  sensorAnomalyQueue: sqs.IQueue;
  devicesTable: dynamodb.ITable;
  telemetryTable: dynamodb.ITable;
  eventLogTable: dynamodb.ITable;
  openCaseLocksTable: dynamodb.ITable;
  eventBus: events.IEventBus;
  openCaseLockTtlSeconds?: number;
  publishLeaseSeconds?: number;
}

// Resuelto desde __dirname (no process.cwd()): estable sin importar desde
// que directorio se invoque `cdk`/`npm test` (por ejemplo, `cd infra &&
// cdk synth` tambien debe funcionar). infra/tsconfig.json compila a
// CommonJS, asi que __dirname siempre esta disponible en este archivo.
const SERVICE_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "ingestion", "src");

/**
 * 3 Lambdas separadas, una por cola, para IAM y escalado independientes.
 * visualAnomalyIngestFn y sensorAnomalyIngestFn comparten la logica de
 * candado/EventLog/EventBridge via services/ingestion/src/anomalyIngestCore.ts;
 * cada una solo importa el validador de su propio contrato.
 */
export class IngestionFunctions extends Construct {
  public readonly telemetryIngestFn: lambdaNodejs.NodejsFunction;
  public readonly visualAnomalyIngestFn: lambdaNodejs.NodejsFunction;
  public readonly sensorAnomalyIngestFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: IngestionFunctionsProps) {
    super(scope, id);

    const commonEnvironment = {
      DEVICES_TABLE_NAME: props.devicesTable.tableName,
      TELEMETRY_TABLE_NAME: props.telemetryTable.tableName,
      EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
      OPEN_CASE_LOCKS_TABLE_NAME: props.openCaseLocksTable.tableName,
      EVENT_BUS_NAME: props.eventBus.eventBusName,
      OPEN_CASE_LOCK_TTL_SECONDS: String(props.openCaseLockTtlSeconds ?? 7200),
      PUBLISH_LEASE_SECONDS: String(props.publishLeaseSeconds ?? 10),
    };

    const commonProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      reservedConcurrentExecutions: 5,
      bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
      handler: "handler",
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

    this.telemetryIngestFn = new lambdaNodejs.NodejsFunction(this, "TelemetryIngestFn", {
      ...commonProps,
      functionName: "SenseCare-telemetryIngest",
      entry: path.join(SERVICE_ENTRY_ROOT, "telemetryIngestHandler.ts"),
      environment: commonEnvironment,
    });
    this.telemetryIngestFn.addEventSource(
      new SqsEventSource(props.telemetryQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );
    props.devicesTable.grant(this.telemetryIngestFn, "dynamodb:GetItem", "dynamodb:UpdateItem");
    props.telemetryTable.grant(this.telemetryIngestFn, "dynamodb:PutItem");

    this.visualAnomalyIngestFn = new lambdaNodejs.NodejsFunction(this, "VisualAnomalyIngestFn", {
      ...commonProps,
      functionName: "SenseCare-visualAnomalyIngest",
      entry: path.join(SERVICE_ENTRY_ROOT, "visualAnomalyIngestHandler.ts"),
      environment: commonEnvironment,
    });
    this.wireAnomalyFunction(this.visualAnomalyIngestFn, props.visualAnomalyQueue, props);

    this.sensorAnomalyIngestFn = new lambdaNodejs.NodejsFunction(this, "SensorAnomalyIngestFn", {
      ...commonProps,
      functionName: "SenseCare-sensorAnomalyIngest",
      entry: path.join(SERVICE_ENTRY_ROOT, "sensorAnomalyIngestHandler.ts"),
      environment: commonEnvironment,
    });
    this.wireAnomalyFunction(this.sensorAnomalyIngestFn, props.sensorAnomalyQueue, props);
  }

  private wireAnomalyFunction(
    fn: lambdaNodejs.NodejsFunction,
    queue: sqs.IQueue,
    props: IngestionFunctionsProps,
  ): void {
    fn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );
    props.devicesTable.grant(fn, "dynamodb:GetItem");
    props.openCaseLocksTable.grant(fn, "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem");
    props.eventLogTable.grant(fn, "dynamodb:PutItem");
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [props.eventBus.eventBusArn],
      }),
    );
  }
}
