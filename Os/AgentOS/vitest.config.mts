import { defineConfig } from 'vitest/config';

/**
 * A10: make the test runner deterministic.
 *
 * Each integration test file sets process.env.DATABASE_URL and relies on the
 * module-level SQLite singleton in src/db/connection.ts. Under a thread pool,
 * `process.env` and module state are shared between workers in one process, so
 * two test files could race over which database the singleton opens.
 *
 * `pool: 'forks'` with isolation gives every test file its own OS process, its
 * own environment and its own module registry -- which is also what makes the
 * multi-process migration test meaningful.
 */
export default defineConfig({
  test: {
    // Build once up front; several suites spawn `node` against dist/.
    globalSetup: ['./tests/globalSetup.ts'],
    pool: 'forks',
    isolate: true,
    /**
     * Cap concurrent test workers.
     *
     * Several suites spawn REAL OS processes (up to 20 claim racers, 6 run
     * workers). With vitest also running one fork per CPU, the machine
     * saturates and those child processes are starved -- observed as
     * intermittent "only 4/6 workers booted" boot-barrier timeouts. Leaving
     * headroom for spawned processes makes the process-level tests reliable
     * without weakening a single assertion.
     */
    maxWorkers: 4,
    minWorkers: 1,
    // Multi-process tests (migration cold boot, package consumer, crash
    // recovery) spawn real child processes and need more than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Keep the structured logger quiet during tests; assertions read state and
    // HTTP responses, not log output.
    env: { LOG_LEVEL: 'silent' }
  }
});
