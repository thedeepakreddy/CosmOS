import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Supervisor } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb, getDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase D: the scheduler must scale.
 *
 * The audit measured per-task cost growing 4.8x between n=100 and n=2000,
 * because every task completion reloaded the whole run and resolved
 * dependencies in JS -- over an unindexed table scan.
 *
 * This is a REGRESSION GATE, not a benchmark. The threshold is deliberately
 * loose (a shared CI machine is noisy); it exists to catch a return to
 * quadratic behaviour, which was a 4.8x signal, not a 2x one.
 */
describe('Scheduler scaling (Phase D)', () => {
  const dbPath = testDbPath('scheduler-scaling');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'sc', version: '1', name: 'sc', description: '', role: '', capabilities: [] });
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });

  async function timeRun(n: number, withDeps = false): Promise<number> {
    const runId = `SC${n}${withDeps ? 'D' : ''}`;
    const now = new Date().toISOString();
    const tasks: Task[] = Array.from({ length: n }, (_, i) => ({
      id: `T${i}`, runId, name: 't', description: '', agentDefinitionId: 'sc',
      state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
    }));
    // A chain forces dependency resolution on every step.
    const dependencies = withDeps
      ? Array.from({ length: n - 1 }, (_, i) => ({ taskId: `T${i + 1}`, dependsOn: `T${i}` }))
      : [];
    stores.runs.save({
      id: runId, goal: 'scale', state: 'CREATED', createdAt: now,
      budget: { maxAgents: 8 }, taskGraph: { tasks, dependencies }
    });

    const sup = new Supervisor({ async execute() { return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 600_000 });
    const t0 = Date.now();
    await sup.startRun(runId);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const state = stores.runs.getMeta(runId)!.state;
      if (state !== 'RUNNING') break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const ms = Date.now() - t0;
    sup.close();
    expect(stores.runs.getMeta(runId)!.state).toBe('COMPLETED');
    return ms;
  }

  it('per-task cost stays near-flat as the run grows (no return to quadratic)', async () => {
    const small = await timeRun(200);
    const large = await timeRun(1600);

    const perSmall = small / 200;
    const perLarge = large / 1600;
    const growth = perLarge / perSmall;

    // Pre-Phase-D this ratio was ~4.8x for an 8x size increase. Anything under
    // 2.5x means the per-completion work is no longer proportional to run size.
    expect(growth, `per-task cost grew ${growth.toFixed(2)}x (small=${perSmall.toFixed(2)}ms large=${perLarge.toFixed(2)}ms)`)
      .toBeLessThan(2.5);
  }, 180_000);

  it('a long dependency chain resolves without scanning the whole graph each step', async () => {
    const ms = await timeRun(600, true);
    // 600 strictly sequential tasks. The old resolver was O(T*D) per completion.
    expect(ms, `chain of 600 took ${ms}ms`).toBeLessThan(60_000);
  }, 180_000);

  it('the scheduling hot paths are all index-backed (no table scans)', () => {
    const db = getDb();
    const plans = [
      ['SELECT state, COUNT(*) AS c FROM tasks WHERE run_id = ? GROUP BY state', ['SC200']],
      [`SELECT * FROM tasks WHERE run_id = ? AND (
           (state = 'READY' AND (not_before IS NULL OR not_before <= ?))
           OR (state = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)) LIMIT 10`,
        ['SC200', Date.now(), Date.now()]],
      [`SELECT COUNT(*) FROM tasks WHERE run_id = ? AND state = 'RUNNING'
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`, ['SC200', Date.now()]]
    ] as const;

    for (const [sql, params] of plans) {
      const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((r) => r.detail).join(' | ');
      expect(detail, `${sql.slice(0, 60)} -> ${detail}`).not.toMatch(/\bSCAN tasks\b/);
    }
  });

  it('dependency resolution is done in SQL, not by hydrating the run', () => {
    const db = getDb();
    const sql = `SELECT t.task_id FROM tasks t
       WHERE t.run_id = ? AND t.state IN ('PENDING','BLOCKED') AND t.owner_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d
           JOIN tasks dep ON dep.run_id = d.run_id AND dep.task_id = d.depends_on
            WHERE d.run_id = t.run_id AND d.task_id = t.task_id AND dep.state <> 'SUCCEEDED')`;
    const steps = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('SC200') as { detail: string }[])
      .map((r) => r.detail);
    const detail = steps.join(' | ');

    // The real invariant: every table access is an indexed SEARCH. A SCAN here
    // would mean dependency resolution walks the run, which is what made the
    // old scheduler quadratic.
    for (const step of steps) {
      expect(step, `unindexed step: ${step}`).not.toMatch(/^SCAN /);
    }
    // Both sides of the dependency join are index-backed.
    expect(detail).toMatch(/sqlite_autoindex_task_dependencies_1/);
    expect(detail).toMatch(/SEARCH dep USING INDEX/);
  });
});
