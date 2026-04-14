import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/vitest/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: false,
    retry: 1,
  },
});
