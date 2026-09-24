import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "node:path";

export interface EvidenceCallbackHandlersProps {
  commandAcksQueue: sqs.IQueue;
  evidenceQueue: sqs.IQueue;
  evidenceCallbacksTable: dynamodb.ITable;
  eventLogTable: dynamodb.ITable;
  evidenceBucket: s3.IBucket;
  resolutionLeaseSeconds?: number;
  evidenceMaxBytes?: number;
}

// Resuelto desde __dirname (no process.cwd()): mismo patron que
// ingestion-functions.ts/case-orchestration.ts.
const SERVICE_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "evidence", "src");

/**
 * SendTaskSuccess/SendTaskFailure no admiten permisos a nivel de recurso
 * (la API no acepta un ARN de ejecucion ni de state machine en la
 * condicion de recurso de IAM); "*" es el unico Resource valido para estas
 * dos acciones. Es, a proposito, el UNICO Resource:"*" de este paquete, y
 * solo para estas dos acciones (aprobado explicitamente durante el diseno
 * de este tramo).
 */
function grantSendTaskOutcome(fn: lambdaNodejs.NodejsFunction): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
      resources: ["*"],
    }),
  );
}

/**
 * Las 2 Lambdas disparadas por SQS que resuelven los callbacks MQTT de la
 * Pi: COMMAND_ACK (topic command-acks) y EVIDENCE_UPLOADED/EVIDENCE_FAILED
 * (topic evidence). Las otras 3 Lambdas del tramo de evidencia
 * (CheckCameraConsent, RequestEvidenceUpload, RecordEvidenceOutcome) son
 * invocadas directamente por Step Functions y viven en
 * case-orchestration.ts junto al resto de la state machine.
 */
export class EvidenceCallbackHandlers extends Construct {
  public readonly commandAckHandlerFn: lambdaNodejs.NodejsFunction;
  public readonly evidenceCallbackHandlerFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: EvidenceCallbackHandlersProps) {
    super(scope, id);

    // Sin reservedConcurrentExecutions: la cuenta debe conservar al menos
    // 10 ejecuciones no reservadas (ver ingestion-functions.ts).
    const commonProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
      handler: "handler",
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

    const resolutionLeaseSeconds = String(props.resolutionLeaseSeconds ?? 30);

    this.commandAckHandlerFn = new lambdaNodejs.NodejsFunction(this, "CommandAckHandlerFn", {
      ...commonProps,
      functionName: "SenseCare-commandAckHandler",
      entry: path.join(SERVICE_ENTRY_ROOT, "commandAckHandlerFn.ts"),
      environment: {
        EVIDENCE_CALLBACKS_TABLE_NAME: props.evidenceCallbacksTable.tableName,
        EVENT_LOG_TABLE_NAME: props.eventLogTable.tableName,
        RESOLUTION_LEASE_SECONDS: resolutionLeaseSeconds,
      },
    });
    this.commandAckHandlerFn.addEventSource(
      new SqsEventSource(props.commandAcksQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );
    props.evidenceCallbacksTable.grant(this.commandAckHandlerFn, "dynamodb:GetItem", "dynamodb:UpdateItem");
    props.eventLogTable.grant(this.commandAckHandlerFn, "dynamodb:PutItem");
    grantSendTaskOutcome(this.commandAckHandlerFn);

    this.evidenceCallbackHandlerFn = new lambdaNodejs.NodejsFunction(this, "EvidenceCallbackHandlerFn", {
      ...commonProps,
      functionName: "SenseCare-evidenceCallbackHandler",
      entry: path.join(SERVICE_ENTRY_ROOT, "evidenceCallbackHandlerFn.ts"),
      environment: {
        EVIDENCE_CALLBACKS_TABLE_NAME: props.evidenceCallbacksTable.tableName,
        EVIDENCE_BUCKET_NAME: props.evidenceBucket.bucketName,
        RESOLUTION_LEASE_SECONDS: resolutionLeaseSeconds,
        EVIDENCE_MAX_BYTES: String(props.evidenceMaxBytes ?? 1_048_576),
      },
    });
    this.evidenceCallbackHandlerFn.addEventSource(
      new SqsEventSource(props.evidenceQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );
    props.evidenceCallbacksTable.grant(
      this.evidenceCallbackHandlerFn,
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    );
    // Sin permiso sobre EventLog aqui: evidenceCallbackHandlerFn no escribe
    // auditoria directamente (a diferencia de commandAckHandlerFn); esa
    // auditoria final la hace siempre recordEvidenceOutcomeFn.
    // HeadObjectCommand requiere s3:GetObject (no existe una accion IAM
    // separada "HeadObject"); acotado al prefijo raw-images/ del bucket,
    // nunca s3:* ni el bucket completo.
    this.evidenceCallbackHandlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:DeleteObject"],
        resources: [props.evidenceBucket.arnForObjects("raw-images/*")],
      }),
    );
    grantSendTaskOutcome(this.evidenceCallbackHandlerFn);
  }
}
