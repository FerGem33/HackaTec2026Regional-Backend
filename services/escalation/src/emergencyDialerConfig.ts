function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de emergencyDialerFn.ts -- la UNICA Lambda de todo
 * SenseCare con permiso `connect:StartOutboundVoiceContact`. Sin default
 * para ninguno de estos valores: deben venir de una verificacion manual del
 * operador (instancia Connect, contact flow y numero de origen reclamados
 * a mano, ver docs/EMERGENCY_CALL_RUNBOOK.md), nunca de un literal en
 * codigo.
 *
 * `fallbackCallDestinationParameterName` es el NOMBRE del parametro SSM
 * SecureString (no el valor, no el ARN): el valor real del numero de
 * destino se fija a mano despues del deploy con
 * `aws ssm put-parameter --type SecureString`, nunca via CDK/Git.
 */
export const config = {
  connectInstanceId: requireEnv("CONNECT_INSTANCE_ID"),
  connectContactFlowId: requireEnv("CONNECT_CONTACT_FLOW_ID"),
  connectSourcePhoneNumber: requireEnv("CONNECT_SOURCE_PHONE_NUMBER"),
  fallbackCallDestinationParameterName: requireEnv("FALLBACK_CALL_DESTINATION_PARAMETER_NAME"),
};
