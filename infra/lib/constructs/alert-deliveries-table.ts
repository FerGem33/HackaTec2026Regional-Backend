import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Auditoría de entrega de push POR endpoint (hito de notificaciones),
 * hermana de `Alerts` (PK caseId, estado GLOBAL del caso: SENT/FAILED/
 * CANCELLED/ESCALATED) sin reemplazarla. PK `caseId`, SK
 * `PUSH#{userId}#{endpointId}`: un mismo caso puede tener N filas, una por
 * cada endpoint al que se intento entregar. `status` es
 * PENDING/PUBLISHED/FAILED -- "PUBLISHED" significa que `sns:Publish`
 * acepto el mensaje, NUNCA que el usuario lo leyo (eso es un concepto de
 * v2, fuera de alcance).
 *
 * Sin TTL: trazabilidad funcional de quien fue notificado y como, misma
 * decision que Alerts/AnomalyCases. RemovalPolicy.RETAIN.
 */
export class AlertDeliveriesTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "AlertDeliveriesTable", {
      tableName: "SenseCare-AlertDeliveries",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "deliveryId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
