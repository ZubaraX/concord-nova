import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: { NODE_ENV: "test", DATA_DIR: "server/.test-data", JWT_SECRET: "test-secret-that-is-long-enough-0123456789", LOG_LEVEL: "warn" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
