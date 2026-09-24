import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "simulators/*/test/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "infra/test/**/*.test.ts",
    ],
    setupFiles: [
      "services/ingestion/test/setupEnv.ts",
      "services/orchestration/test/setupEnv.ts",
      "services/evidence/test/setupEnv.ts",
      "services/analysis/test/setupEnv.ts",
      "services/cases/test/setupEnv.ts",
    ],
  },
});
