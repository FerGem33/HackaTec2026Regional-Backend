import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { AnomalyDetectedEventDetail } from "@sensecare/contracts";

/**
 * Prompt de sistema fijo. Nunca recibe nombres, direcciones, datos medicos
 * ni identificadores internos (caseId/deviceId/recipientId no se mencionan
 * aqui). Exige JSON estricto, prohibe diagnostico/acusacion, y obliga a
 * expresar incertidumbre en vez de inventar certeza.
 */
export const ANALYSIS_SYSTEM_PROMPT = `Eres un sistema de apoyo, no un profesional medico ni de seguridad.
Responde UNICAMENTE con un objeto JSON valido, sin texto adicional, sin
bloques de codigo markdown, con exactamente esta forma:
{"personDetected": boolean, "posture": "standing"|"lying_or_fallen"|"unknown",
 "riskIndicators": ["POSSIBLE_FALL"|"POSSIBLE_UNCONSCIOUSNESS"|"PERSON_PRONE_INACTIVE"|"UNEXPECTED_PERSON"|"POSSIBLE_SMOKE_OR_FIRE"|"CAMERA_TAMPERED", ...] (vacio si no aplica),
 "needsHumanReview": boolean, "confidence": number entre 0 y 1,
 "summary": string, maximo 280 caracteres, en espanol neutro}

Reglas obligatorias:
- Nunca emitas un diagnostico medico ni afirmes una condicion de salud.
- Nunca acuses a una persona identificable de un delito.
- Si hay cualquier incertidumbre o senal de peligro, needsHumanReview=true.
- No inventes certeza: si la escena no es clara, dilo en summary y baja confidence.
- No describas rasgos que permitan identificar a una persona (rostro, nombre,
  ropa distintiva) mas alla de lo necesario para posture/riskIndicators.`;

/**
 * Texto minimo de contexto: solo el motivo de captura ya conocido por el
 * propio backend (enums, no texto libre). Nunca recipientId, deviceId,
 * telemetria cruda ni narrativa del caso.
 */
export function buildUserContextText(
  anomalyType: AnomalyDetectedEventDetail["anomalyType"],
  captureMode: "BUFFERED" | "CURRENT",
): string {
  return `Motivo de captura: ${anomalyType} (modo ${captureMode}).`;
}

export function buildConverseInput(params: {
  modelId: string;
  maxTokens: number;
  temperature: number;
  imageBytes: Uint8Array;
  contextText: string;
}): ConverseCommandInput {
  return {
    modelId: params.modelId,
    system: [{ text: ANALYSIS_SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [
          { image: { format: "jpeg", source: { bytes: params.imageBytes } } },
          { text: params.contextText },
        ],
      },
    ],
    inferenceConfig: {
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    },
  };
}

/**
 * Extrae el primer bloque de texto de la respuesta de Converse. No asume
 * que el modelo respeto el formato pedido: el llamador debe validar el
 * resultado contra observationSchema antes de confiar en el.
 */
export function extractResponseText(output: unknown): string | undefined {
  const message = (output as { output?: { message?: { content?: Array<{ text?: string }> } } })?.output
    ?.message;
  const textBlock = message?.content?.find((block) => typeof block.text === "string");
  return textBlock?.text;
}

/**
 * El prompt pide JSON puro, pero algunos modelos igual envuelven la
 * respuesta en una cerca de codigo markdown (```json ... ```). Se
 * despoja de forma defensiva antes de JSON.parse; si el resultado no es
 * JSON valido, el llamador lo trata como INVALID_OUTPUT.
 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch?.[1] ?? trimmed;
}
