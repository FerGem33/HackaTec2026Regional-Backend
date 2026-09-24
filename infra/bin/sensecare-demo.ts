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

function optionalStringList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
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
  // Hito de escalamiento: instancia/contact flow/numero de origen de
  // Connect se reclaman a mano antes del deploy (ver
  // docs/EMERGENCY_CALL_RUNBOOK.md); nunca un default ni un literal en
  // codigo. El NOMBRE del parametro SSM si tiene un default razonable (no
  // es secreto); su VALOR se fija a mano despues del deploy.
  connectInstanceId: requireEnv("CONNECT_INSTANCE_ID"),
  connectContactFlowId: requireEnv("CONNECT_CONTACT_FLOW_ID"),
  connectSourcePhoneNumber: requireEnv("CONNECT_SOURCE_PHONE_NUMBER"),
  fallbackCallDestinationParameterName:
    process.env.FALLBACK_CALL_DESTINATION_PARAMETER_NAME || "/sensecare/demo/fallback-call-destination",
  escalationAllowedDeviceIds: optionalStringList("ESCALATION_ALLOWED_DEVICE_IDS"),
  // Ausente/"false" por defecto: bloquea SIEMPRE el camino automatico de
  // llamada hasta que el operador confirme a mano un canal humano de
  // notificacion real (sin correos/push/WhatsApp configurados todavia).
  humanNotificationChannelConfirmed: process.env.HUMAN_NOTIFICATION_CHANNEL_CONFIRMED === "true",
});
