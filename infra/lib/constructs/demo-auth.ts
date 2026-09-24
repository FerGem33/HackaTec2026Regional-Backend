import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/**
 * Identidad minima para el endpoint HTTPS de demo (Hito 5). Un User Pool
 * simple, sin auto-registro publico ni verificacion de correo (los
 * usuarios de demo los crea a mano quien administra la cuenta, via
 * `aws cognito-idp admin-create-user` + `admin-set-user-password`; ver
 * docs/DEMO_INGEST_AUTH.md). El cliente no tiene secreto porque el JWT lo
 * obtiene directamente el navegador (USER_PASSWORD_AUTH), no un backend
 * server-to-server.
 *
 * Este pool es exclusivamente para el simulador web: nunca debe usarse
 * para autenticar Raspberry Pis reales (esas usan certificado X.509 por
 * AWS IoT Core, ver DeviceAccessPolicy) ni para el login de familiares del
 * producto final (fuera de alcance del hackathon).
 */
export class DemoAuth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, "DemoUserPool", {
      userPoolName: "SenseCare-demo-simulator",
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      standardAttributes: { email: { required: false, mutable: true } },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient("DemoWebClient", {
      userPoolClientName: "SenseCare-demo-web-simulator",
      generateSecret: false,
      authFlows: { userPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });
  }
}
