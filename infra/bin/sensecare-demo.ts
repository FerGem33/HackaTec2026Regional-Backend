import * as cdk from "aws-cdk-lib";
import { SenseCareDemoStack } from "../lib/sensecare-demo-stack";

const app = new cdk.App();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Falta la variable de entorno requerida: ${name}. Verifica modelos/inference ` +
        "profiles disponibles con `aws bedrock list-foundation-models`/`list-inference-profiles` " +
        "(solo lectura) antes de exportarla; nunca se usa un valor por defecto.",
    );
  }
  return value;
}

function optionalEmailList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const emails = raw
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
  return emails.length > 0 ? emails : undefined;
}

new SenseCareDemoStack(app, "SenseCareDemoStack", {
  description: "SenseCare demo stack.",
  bedrockModelId: requireEnv("BEDROCK_MODEL_ID"),
  bedrockInferenceProfileArn: requireEnv("BEDROCK_INFERENCE_PROFILE_ARN"),
  bedrockFoundationModelArns: requireEnv("BEDROCK_FOUNDATION_MODEL_ARNS")
    .split(",")
    .map((arn) => arn.trim())
    .filter((arn) => arn.length > 0),
  // Opcionales a proposito: sin ellas, cero suscripciones se crean por CDK y
  // se agregan a mano tras el deploy (ver runbook de alertas). Nunca un
  // email real en el repositorio ni un valor por defecto.
  alertSubscriptionEmails: optionalEmailList("ALERT_SUBSCRIPTION_EMAILS"),
  operationalSubscriptionEmails: optionalEmailList("OPERATIONAL_SUBSCRIPTION_EMAILS"),
});
