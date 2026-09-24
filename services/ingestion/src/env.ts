/**
 * Helpers puros de lectura de entorno: sin efectos secundarios, sin objeto
 * de configuracion eager. Importar este modulo nunca exige ninguna
 * variable de entorno por si mismo.
 *
 * config.ts (las 3 Lambdas SQS de ingesta), queryConfig.ts y demoConfig.ts
 * (las Lambdas HTTP de Hito 5) declaran cada uno su PROPIO objeto de
 * configuracion usando estos helpers, con exactamente las variables que su
 * propia Lambda necesita -- mismo patron que
 * services/evidence/src/env.ts y services/analysis/src/env.ts.
 *
 * Antes de este archivo, queryConfig.ts/demoConfig.ts importaban
 * `requireEnv` directamente desde config.ts. Un modulo ES ejecuta TODO su
 * cuerpo top-level al importarse, asi que eso arrastraba el objeto `config`
 * eager de config.ts (que exige las 5 variables de las Lambdas SQS) incluso
 * en Lambdas HTTP que nunca reciben esas variables, provocando un crash en
 * cold start en produccion (`Falta la variable de entorno requerida:
 * EVENT_LOG_TABLE_NAME`) pese a que los tests locales pasaban -- el
 * setupEnv.ts compartido de este paquete define las 5 variables para todos
 * los tests, enmascarando el problema.
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
