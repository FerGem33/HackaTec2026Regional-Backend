import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

/**
 * `sub` es el identificador estable y unico del usuario dentro del User
 * Pool de Cognito. API Gateway ya valido firma y expiracion del JWT antes
 * de invocar el Lambda (authorizer tipo JWT); esto solo extrae el claim,
 * nunca vuelve a verificar el token. Mismo helper que
 * services/ingestion/src/authContext.ts, duplicado a proposito (ver
 * casesConfig.ts).
 */
export function getUserId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}
