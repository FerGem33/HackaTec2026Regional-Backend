import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Registro deduplicado de la alerta humana de un caso (Hito de alertas).
 * PK caseId, sin SK: la unidad natural de dedup no es "un alertId por
 * evento" sino "una alerta por caso completo", igual que AnomalyCases y
 * OpenCaseLocks ya modelan "un caso" como una sola fila por caseId. Esto
 * difiere del diseno conceptual original de docs/ARCHITECTURE.md (PK
 * recipientId / SK createdAt#alertId, pensado para listar el historial de
 * alertas de un paciente); se prefiere este diseno mas simple porque
 * DispatchAlertFn necesita un `PutItem` condicional atomico por caseId como
 * unico mecanismo de dedup (ver docstring de dispatchAlertFn.ts).
 *
 * Sin TTL: es trazabilidad funcional del caso (quien decidio, cuando, con
 * que resultado), no un dato efimero -- mismo criterio que AnomalyCases.
 * RemovalPolicy.RETAIN, igual que el resto de tablas operativas.
 */
export class AlertsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "AlertsTable", {
      tableName: "SenseCare-Alerts",
      partitionKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
