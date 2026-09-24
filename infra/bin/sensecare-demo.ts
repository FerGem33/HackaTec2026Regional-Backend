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

new SenseCareDemoStack(app, "SenseCareDemoStack", {
  description: "SenseCare demo stack.",
  bedrockModelId: requireEnv("BEDROCK_MODEL_ID"),
  bedrockInferenceProfileArn: requireEnv("BEDROCK_INFERENCE_PROFILE_ARN"),
  bedrockFoundationModelArns: requireEnv("BEDROCK_FOUNDATION_MODEL_ARNS")
    .split(",")
    .map((arn) => arn.trim())
    .filter((arn) => arn.length > 0),
});
