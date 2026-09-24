import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "node:path";

export interface PushDevicesApiProps {
  httpApi: apigwv2.HttpApi;
  authorizer: apigwv2.IHttpRouteAuthorizer;
  caregiverPushEndpointsTable: dynamodb.ITable;
  /** Id de la App de Pinpoint (ver push-application.ts), no un ARN. */
  pinpointApplicationId: string;
}

const SERVICE_ENTRY_ROOT = path.resolve(__dirname, "..", "..", "..", "services", "push", "src");

const commonFnProps = {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  memorySize: 512,
  timeout: cdk.Duration.seconds(10),
  bundling: { format: lambdaNodejs.OutputFormat.CJS, target: "node22" },
  handler: "handler",
} satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

/**
 * Registro/baja de dispositivos moviles para push dirigido (hito de
 * notificaciones): POST /me/push-devices, DELETE
 * /me/push-devices/{endpointId}. Mismo HttpApi/JWT que CasesApi y
 * DemoIngestApi (un solo Cognito User Pool para todo el demo).
 *
 * Solo se instancia si existe una App de Pinpoint real (ver
 * SenseCareDemoStack): sin `FCM_SERVICE_ACCOUNT_JSON`, ninguna de estas 2
 * rutas existe todavia, en vez de desplegar rutas que fallarian en cada
 * llamada.
 */
export class PushDevicesApi extends Construct {
  public readonly registerPushDeviceFn: lambdaNodejs.NodejsFunction;
  public readonly unregisterPushDeviceFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: PushDevicesApiProps) {
    super(scope, id);

    // Pinpoint conserva el namespace historico "mobiletargeting" en IAM y
    // ARNs (nunca "pinpoint"), aunque AWS lo mercadee hoy como "End User
    // Messaging Push". Acotado a ESTA app especifica, nunca a apps/*.
    const appArn = `arn:aws:mobiletargeting:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:apps/${props.pinpointApplicationId}`;

    this.registerPushDeviceFn = new lambdaNodejs.NodejsFunction(this, "RegisterPushDeviceFn", {
      ...commonFnProps,
      functionName: "SenseCare-registerPushDevice",
      entry: path.join(SERVICE_ENTRY_ROOT, "registerPushDeviceHandler.ts"),
      environment: {
        CAREGIVER_PUSH_ENDPOINTS_TABLE_NAME: props.caregiverPushEndpointsTable.tableName,
        PINPOINT_APPLICATION_ID: props.pinpointApplicationId,
      },
    });
    props.caregiverPushEndpointsTable.grant(this.registerPushDeviceFn, "dynamodb:UpdateItem");
    // mobiletargeting:UpdateEndpoint acotado a los endpoints de ESTA app,
    // nunca mobiletargeting:* ni otra app/proyecto de Pinpoint.
    this.registerPushDeviceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["mobiletargeting:UpdateEndpoint"],
        resources: [`${appArn}/endpoints/*`],
      }),
    );

    this.unregisterPushDeviceFn = new lambdaNodejs.NodejsFunction(this, "UnregisterPushDeviceFn", {
      ...commonFnProps,
      functionName: "SenseCare-unregisterPushDevice",
      entry: path.join(SERVICE_ENTRY_ROOT, "unregisterPushDeviceHandler.ts"),
      environment: {
        CAREGIVER_PUSH_ENDPOINTS_TABLE_NAME: props.caregiverPushEndpointsTable.tableName,
        PINPOINT_APPLICATION_ID: props.pinpointApplicationId,
      },
    });
    props.caregiverPushEndpointsTable.grant(this.unregisterPushDeviceFn, "dynamodb:GetItem", "dynamodb:DeleteItem");
    this.unregisterPushDeviceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["mobiletargeting:DeleteEndpoint"],
        resources: [`${appArn}/endpoints/*`],
      }),
    );

    props.httpApi.addRoutes({
      path: "/me/push-devices",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("RegisterPushDeviceIntegration", this.registerPushDeviceFn),
      authorizer: props.authorizer,
    });

    props.httpApi.addRoutes({
      path: "/me/push-devices/{endpointId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("UnregisterPushDeviceIntegration", this.unregisterPushDeviceFn),
      authorizer: props.authorizer,
    });
  }
}
