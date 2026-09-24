import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "simulators/*/test/**/*.test.ts",
    ],
  },
});
