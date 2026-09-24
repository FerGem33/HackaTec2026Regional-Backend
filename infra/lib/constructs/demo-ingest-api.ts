import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import * as path from "node:path";

export interface DemoApiProps {
  telemetryQueue: sqs.IQueue;
  sensorAnomalyQueue: sqs.IQueue;
  devicesTable: dynamodb.ITable;
  telemetryTable: dynamodb.ITable;
  caregiverAccessTable: dynamodb.ITable;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  /** deviceId reservados para el simulador web; nunca deviceId de una Pi real con certificado X.509. */
  demoDeviceAllowlist: string[];
}

const SERVICE_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "ingestion", "src");

const commonFnProps = {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  memorySize: 512,
  timeout: cdk.Duration.seconds(10),
  bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
  handler: "handler",
} satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

/**
 * API HTTP del Hito 5 para clientes que no son la Pi (simulador web y app
 * movil): ingesta de telemetria/anomalias de sensor del simulador, y
 * consulta de solo lectura de CUALQUIER deviceId (incluida la Pi fisica
 * real, que llega por MQTT/IoT Core, no por aqui). Las rutas de
 * cancelacion/escalamiento de familiares quedan pendientes (ver TODO en
 * sensecare-demo-stack.ts). Autorizado por JWT de Cognito (DemoAuth) en
 * todas las rutas.
 *
 * Importante: la allowlist de deviceId SOLO aplica a la ruta de ingesta
 * (evita que HTTPS suplante a un dispositivo con certificado X.509 real).
 * Las rutas de lectura usan CaregiverAccess en su lugar (emparejamiento
 * por QR + pairingCode via POST /devices/{deviceId}/pair): un JWT valido
 * no basta para leer un deviceId que ese usuario nunca emparejo -- ver
 * caregiverAccess.ts.
 */
export class DemoIngestApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly ingestFn: lambdaNodejs.NodejsFunction;
  public readonly getLatestFn: lambdaNodejs.NodejsFunction;
  public readonly getTelemetryFn: lambdaNodejs.NodejsFunction;
  public readonly pairDeviceFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: DemoApiProps) {
    super(scope, id);

    this.ingestFn = new lambdaNodejs.NodejsFunction(this, "DemoIngestFn", {
      ...commonFnProps,
      functionName: "SenseCare-demoIngest",
      entry: path.join(SERVICE_ENTRY_ROOT, "demoIngestHandler.ts"),
      environment: {
        DEMO_TELEMETRY_QUEUE_URL: props.telemetryQueue.queueUrl,
        DEMO_SENSOR_ANOMALY_QUEUE_URL: props.sensorAnomalyQueue.queueUrl,
        DEMO_DEVICE_ALLOWLIST: props.demoDeviceAllowlist.join(","),
      },
    });
    // Solo enviar mensajes a estas 2 colas puntuales, nunca sqs:* ni ARN
    // comodin (mismo patron de minimo privilegio que IngestionFunctions).
    props.telemetryQueue.grantSendMessages(this.ingestFn);
    props.sensorAnomalyQueue.grantSendMessages(this.ingestFn);

    const readEnvironment = {
      DEVICES_TABLE_NAME: props.devicesTable.tableName,
      TELEMETRY_TABLE_NAME: props.telemetryTable.tableName,
      CAREGIVER_ACCESS_TABLE_NAME: props.caregiverAccessTable.tableName,
    };

    this.getLatestFn = new lambdaNodejs.NodejsFunction(this, "GetDeviceLatestFn", {
      ...commonFnProps,
      functionName: "SenseCare-getDeviceLatest",
      entry: path.join(SERVICE_ENTRY_ROOT, "getDeviceLatestHandler.ts"),
      environment: readEnvironment,
    });
    props.devicesTable.grant(this.getLatestFn, "dynamodb:GetItem");
    props.telemetryTable.grant(this.getLatestFn, "dynamodb:Query");
    props.caregiverAccessTable.grant(this.getLatestFn, "dynamodb:GetItem");

    this.getTelemetryFn = new lambdaNodejs.NodejsFunction(this, "GetDeviceTelemetryFn", {
      ...commonFnProps,
      functionName: "SenseCare-getDeviceTelemetry",
      entry: path.join(SERVICE_ENTRY_ROOT, "getDeviceTelemetryHandler.ts"),
      environment: readEnvironment,
    });
    props.telemetryTable.grant(this.getTelemetryFn, "dynamodb:Query");
    props.caregiverAccessTable.grant(this.getTelemetryFn, "dynamodb:GetItem");

    this.pairDeviceFn = new lambdaNodejs.NodejsFunction(this, "PairDeviceFn", {
      ...commonFnProps,
      functionName: "SenseCare-pairDevice",
      entry: path.join(SERVICE_ENTRY_ROOT, "pairDeviceHandler.ts"),
      environment: readEnvironment,
    });
    props.devicesTable.grant(this.pairDeviceFn, "dynamodb:GetItem");
    props.caregiverAccessTable.grant(this.pairDeviceFn, "dynamodb:PutItem");

    const authorizer = new HttpJwtAuthorizer("DemoJwtAuthorizer", props.userPool.userPoolProviderUrl, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
    });

    this.httpApi = new apigwv2.HttpApi(this, "DemoIngestHttpApi", {
      apiName: "SenseCare-demo-api",
      description:
        "Hito 5: ingesta HTTPS del simulador web (sin VISUAL_ANOMALY) + emparejamiento por QR + consulta de solo lectura de telemetria por deviceId ya emparejado.",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.GET],
        allowHeaders: ["content-type", "authorization"],
      },
    });

    this.httpApi.addRoutes({
      path: "/demo/devices/{deviceId}/events",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("DemoIngestIntegration", this.ingestFn),
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/devices/{deviceId}/pair",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("PairDeviceIntegration", this.pairDeviceFn),
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/devices/{deviceId}/latest",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("GetDeviceLatestIntegration", this.getLatestFn),
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/devices/{deviceId}/telemetry",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("GetDeviceTelemetryIntegration", this.getTelemetryFn),
      authorizer,
    });
  }
}
