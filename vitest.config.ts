import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/{unit,integration,e2e}/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: true,
    retry: 1,
  },
});
