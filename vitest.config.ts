import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // integration + chaos suites share one Postgres database, so files run one at a time
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/unkillable_test',
    },
  },
})
