import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

/**
 * Mismo helper que services/cases/src/authContext.ts, duplicado a
 * proposito: cada services/* es una unidad de despliegue independiente
 * (ver casesConfig.ts para el razonamiento completo).
 */
export function getUserId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}
