import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Tabla nueva del Hito 4. No modifica ingestion-tables.ts (Hito 2): las 4
 * tablas de ingesta quedan intactas.
 *
 * Sin TTL: a diferencia de OpenCaseLocks (un candado efimero), un caso es
 * un registro durable. RemovalPolicy.RETAIN, igual que las tablas de
 * Hito 2, para que un cdk destroy nunca borre datos de caso.
 */
export class AnomalyCasesTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "AnomalyCasesTable", {
      tableName: "SenseCare-AnomalyCases",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
