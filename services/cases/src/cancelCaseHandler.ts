import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { handleCaseDecision } from "./decisionHandlerCore.js";

/**
 * POST /cases/{caseId}/cancel -- CANCEL_ALERT de un familiar autorizado (ver
 * decisionHandlerCore.ts). Solo un usuario con CaregiverAccess sobre el
 * deviceId del caso puede ejecutar esta accion.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  return handleCaseDecision(event, "CANCELLED");
}
