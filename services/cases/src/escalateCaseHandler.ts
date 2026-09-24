import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { handleCaseDecision } from "./decisionHandlerCore.js";

/**
 * POST /cases/{caseId}/escalate -- ESCALATE de un familiar autorizado (ver
 * decisionHandlerCore.ts). Solo registra/adelanta la intencion humana; no
 * dispara ninguna llamada en este hito (sin fallback telefonico todavia).
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  return handleCaseDecision(event, "ESCALATED");
}
