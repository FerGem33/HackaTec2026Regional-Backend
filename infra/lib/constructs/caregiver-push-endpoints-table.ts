import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Dispositivos móviles registrados por cada cuidador para push dirigido
 * (hito de notificaciones). PK `userId` (el `sub` de Cognito, nunca un
 * `deviceId` de sensor), SK `endpointId` (el id de SNS Platform Endpoint,
 * un usuario puede tener varios equipos). `snsEndpointArn` nunca se expone
 * fuera del backend (ni por API, ni en logs, ni en EventLog) -- es el
 * unico dato que permitiria enviar push directo a ese equipo.
 *
 * Sin TTL: es una preferencia/registro durable del usuario, no un dato
 * efimero. RemovalPolicy.RETAIN, mismo criterio que el resto de tablas de
 * este hito.
 */
export class CaregiverPushEndpointsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "CaregiverPushEndpointsTable", {
      tableName: "SenseCare-CaregiverPushEndpoints",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "endpointId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
