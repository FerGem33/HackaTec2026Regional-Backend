import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regresion del incidente de produccion documentado en
 * services/ingestion/src/env.ts: las 4 Lambdas HTTP de Hito 5
 * (pairDeviceFn, getDeviceLatestFn, getDeviceTelemetryFn, demoIngestFn)
 * crasheaban en cold start real con
 * "Falta la variable de entorno requerida: EVENT_LOG_TABLE_NAME" porque
 * queryConfig.ts/demoConfig.ts importaban `requireEnv` desde config.ts, lo
 * que arrastraba el objeto `config` eager de las 3 Lambdas SQS (que exige
 * EVENT_LOG_TABLE_NAME/OPEN_CASE_LOCKS_TABLE_NAME/EVENT_BUS_NAME) aunque
 * las Lambdas HTTP nunca reciben esas variables.
 *
 * Los tests normales de este paquete NO detectan esto: test/setupEnv.ts,
 * compartido por todo el paquete, define las 5 variables de las Lambdas
 * SQS para TODOS los tests, enmascarando el problema. Este archivo lo borra
 * deliberadamente antes de cada prueba y fuerza una recarga limpia de
 * modulos (`vi.resetModules()`) para reproducir el entorno real que CDK le
 * da a cada Lambda HTTP (ver infra/lib/constructs/demo-ingest-api.ts):
 * exactamente sus variables declaradas, ninguna de las de SQS.
 *
 * Con la implementacion anterior (queryConfig.ts/demoConfig.ts importando
 * requireEnv de config.ts), cada prueba de "carga sin las variables de
 * SQS" de este archivo fallaba. Con env.ts como helper puro compartido,
 * pasan.
 */

const SQS_ONLY_VARS = [
  "EVENT_LOG_TABLE_NAME",
  "OPEN_CASE_LOCKS_TABLE_NAME",
  "EVENT_BUS_NAME",
  "OPEN_CASE_LOCK_TTL_SECONDS",
  "PUBLISH_LEASE_SECONDS",
  "TELEMETRY_RETENTION_DAYS",
] as const;

let savedValues: Partial<Record<(typeof SQS_ONLY_VARS)[number], string>>;

beforeEach(() => {
  vi.resetModules();
  savedValues = {};
  for (const name of SQS_ONLY_VARS) {
    const current = process.env[name];
    if (current !== undefined) {
      savedValues[name] = current;
    }
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of SQS_ONLY_VARS) {
    const saved = savedValues[name];
    if (saved !== undefined) {
      process.env[name] = saved;
    }
  }
});

describe("HTTP Lambda config cold start isolation (production incident regression)", () => {
  it("queryConfig.ts loads with only its own 3 declared variables, none of the SQS-only ones", async () => {
    const mod = await import("../src/queryConfig.js");
    expect(mod.queryConfig.devicesTableName).toBe(process.env.DEVICES_TABLE_NAME);
    expect(mod.queryConfig.caregiverAccessTableName).toBe(process.env.CAREGIVER_ACCESS_TABLE_NAME);
  });

  it("demoConfig.ts loads with only its own 3 declared variables, none of the SQS-only ones", async () => {
    const mod = await import("../src/demoConfig.js");
    expect(mod.demoConfig.telemetryQueueUrl).toBe(process.env.DEMO_TELEMETRY_QUEUE_URL);
  });

  it("pairDeviceHandler.ts loads with exactly the environment CDK gives PairDeviceFn", async () => {
    const mod = await import("../src/pairDeviceHandler.js");
    expect(mod.handler).toBeTypeOf("function");
  });

  it("getDeviceLatestHandler.ts loads with exactly the environment CDK gives GetDeviceLatestFn", async () => {
    const mod = await import("../src/getDeviceLatestHandler.js");
    expect(mod.handler).toBeTypeOf("function");
  });

  it("getDeviceTelemetryHandler.ts loads with exactly the environment CDK gives GetDeviceTelemetryFn", async () => {
    const mod = await import("../src/getDeviceTelemetryHandler.js");
    expect(mod.handler).toBeTypeOf("function");
  });

  it("demoIngestHandler.ts loads with exactly the environment CDK gives DemoIngestFn", async () => {
    const mod = await import("../src/demoIngestHandler.js");
    expect(mod.handler).toBeTypeOf("function");
  });

  it("config.ts (the 3 SQS Lambdas) still fails fast when a required variable is missing (regression guard)", async () => {
    // EVENT_LOG_TABLE_NAME ya esta borrada por el beforeEach de este
    // archivo; config.ts SI debe exigirla (a diferencia de las Lambdas
    // HTTP), preservando el comportamiento original de las Lambdas SQS.
    await expect(import("../src/config.js")).rejects.toThrow(
      /Falta la variable de entorno requerida: EVENT_LOG_TABLE_NAME/,
    );
  });
});
