/**
 * Helpers puros de lectura de entorno, sin objeto de configuracion
 * compartido (misma leccion que services/evidence/src/env.ts): cada Lambda
 * declara su propio `config` local con exactamente las variables que usa.
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
    throw new Error(`La variable de entorno ${name} debe ser un entero positivo; se recibio: "${raw}"`);
  }
  return parsed;
}

export function requireTemperature(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`La variable de entorno ${name} debe estar entre 0 y 1; se recibio: "${raw}"`);
  }
  return parsed;
}
