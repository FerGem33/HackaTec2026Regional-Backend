import { describe, expect, it, vi } from "vitest";

/**
 * Regresion del mismo incidente ya corregido en services/ingestion/src/env.ts:
 * un modulo ES ejecuta TODO su cuerpo top-level al importarse. Si
 * reconcileHumanDecisionFn.ts compartiera config con requestHumanDecisionFn.ts
 * (que tambien exige ANOMALY_CASES_TABLE_NAME), fallaria en cold start en
 * CDK, donde ReconcileHumanDecisionFn solo recibe
 * CASE_ACTION_CALLBACKS_TABLE_NAME. Esta prueba reproduce el cold start real
 * quitando ANOMALY_CASES_TABLE_NAME y forzando una reevaluacion genuina del
 * modulo con `vi.resetModules()`.
 */
describe("reconcileHumanDecisionFn cold start isolation", () => {
  it("loads with exactly the environment CDK gives ReconcileHumanDecisionFn (no ANOMALY_CASES_TABLE_NAME)", async () => {
    const savedAnomalyCasesTableName = process.env.ANOMALY_CASES_TABLE_NAME;
    delete process.env.ANOMALY_CASES_TABLE_NAME;

    try {
      vi.resetModules();
      await expect(import("../src/reconcileHumanDecisionFn.js")).resolves.toBeDefined();
    } finally {
      process.env.ANOMALY_CASES_TABLE_NAME = savedAnomalyCasesTableName;
      vi.resetModules();
    }
  });

  it("requestHumanDecisionConfig.ts still fails fast when ANOMALY_CASES_TABLE_NAME is genuinely missing (regression guard)", async () => {
    const savedAnomalyCasesTableName = process.env.ANOMALY_CASES_TABLE_NAME;
    delete process.env.ANOMALY_CASES_TABLE_NAME;

    try {
      vi.resetModules();
      await expect(import("../src/requestHumanDecisionConfig.js")).rejects.toThrow(
        "Falta la variable de entorno requerida: ANOMALY_CASES_TABLE_NAME",
      );
    } finally {
      process.env.ANOMALY_CASES_TABLE_NAME = savedAnomalyCasesTableName;
      vi.resetModules();
    }
  });
});
