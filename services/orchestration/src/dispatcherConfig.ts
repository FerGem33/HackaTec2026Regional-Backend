function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

/**
 * Config exclusiva de caseDispatcherFn, en un archivo separado de
 * taskConfig.ts a proposito: un modulo ES ejecuta TODO su cuerpo top-level
 * al importarse, sin importar que export uses. Si caseDispatcherFn (que
 * en CDK solo recibe STATE_MACHINE_ARN) importara un config.ts que
 * tambien exige OPEN_CASE_LOCKS_TABLE_NAME/ANOMALY_CASES_TABLE_NAME,
 * fallaria en cold start por variables que nunca necesita.
 */
export const config = {
  stateMachineArn: requireEnv("STATE_MACHINE_ARN"),
};
