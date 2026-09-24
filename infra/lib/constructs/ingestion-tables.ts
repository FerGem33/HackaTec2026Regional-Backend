import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Las 4 tablas autorizadas para el Hito 2. CareRecipients, Alerts,
 * Observations, AnomalyCases y CaregiverAccess quedan para hitos
 * posteriores (no se crean aqui).
 *
 * RemovalPolicy.RETAIN en las 4: un `cdk destroy` de la pila de demo no
 * debe borrar datos operativos por accidente.
 */
export class IngestionTables extends Construct {
  public readonly devicesTable: dynamodb.Table;
  public readonly telemetryTable: dynamodb.Table;
  public readonly eventLogTable: dynamodb.Table;
  public readonly openCaseLocksTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.devicesTable = new dynamodb.Table(this, "DevicesTable", {
      tableName: "SenseCare-Devices",
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.telemetryTable = new dynamodb.Table(this, "TelemetryTable", {
      tableName: "SenseCare-Telemetry",
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "occurredAtEventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.eventLogTable = new dynamodb.Table(this, "EventLogTable", {
      tableName: "SenseCare-EventLog",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "occurredAtEventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // TTL provisional de 2 horas (ver services/ingestion/src/config.ts).
    // El Hito 4 debe renovarlo mientras el caso siga abierto (Step
    // Functions Standard corriendo) y liberar/dejar expirar el lock al
    // resolver o escalar el caso; este hito no lo hace todavia.
    this.openCaseLocksTable = new dynamodb.Table(this, "OpenCaseLocksTable", {
      tableName: "SenseCare-OpenCaseLocks",
      partitionKey: { name: "lockKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
