import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

/**
 * `sub` es el identificador estable y unico del usuario dentro del User
 * Pool de Cognito (no cambia si el usuario cambia su email/username); es
 * la clave de particion de CaregiverAccess. API Gateway ya valido firma y
 * expiracion del JWT antes de invocar el Lambda (authorizer tipo JWT);
 * esto solo extrae el claim, no vuelve a verificar el token.
 */
export function getUserId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}
