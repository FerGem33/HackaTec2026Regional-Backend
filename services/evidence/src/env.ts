/**
 * Helpers puros de lectura de entorno, sin objeto de configuracion
 * compartido: un modulo ES ejecuta TODO su cuerpo top-level al importarse,
 * asi que un solo config.ts con todas las variables de las 5 Lambdas de
 * este paquete rompería el cold start de cualquiera que no las use todas
 * (misma leccion aprendida en Hito 4a con dispatcherConfig/taskConfig).
 * Cada Lambda declara su propio objeto `config` local usando estos
 * helpers, con exactamente las variables que necesita.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

export function requirePositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `La variable de entorno ${name} debe ser un entero positivo; se recibio: "${raw}"`,
    );
  }
  return parsed;
}
