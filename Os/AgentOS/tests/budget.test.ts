import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Supervisor, DEFAULT_MAX_CONCURRENCY } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, ExecutionBudget, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * A3: budget boundary correctness.
 *
 * The audit found every zero-valued budget silently disabling itself, because
 * the implementation used `||` and truthiness tests. The semantics asserted here
 * are explicit: 0 means "zero allowed"; only `undefined` means unset; negative
 * values are rejected as invalid.
 */
describe('Budget boundaries (A3)', () => {
  const dbPath = testDbPath('budget');
  process.env.DATABASE_URL = dbPath;

  let seq = 0;
  let stores: Stores;
  const okExecutor: AgentExecutor = {
    async execute() {
      return { status: 'SUCCEEDED', output: 1 };
    }
  };

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    for (const id of ['a1', 'a2', 'a3']) {
      stores.agents.save({
        id, version: '1', name: id, description: '', role: '', capabilities: []
      });
    }
  });

  afterAll(() => {
    closeDb();
    removeDb(dbPath);
  });

  beforeEach(() => { seq++; });

  /** Create a run with `taskCount` tasks spread over `agentCount` agent definitions. */
  function makeRun(budget: ExecutionBudget | undefined, taskCount: number, agentCount = 1): string {
    const runId = `B${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const agents = ['a1', 'a2', 'a3'];
    const tasks: Task[] = Array.from({ length: taskCount }, (_, i) => ({
      id: `${runId}#${i}`,
      runId,
      name: `t${i}`,
      description: '',
      agentDefinitionId: agents[i % agentCount],
      state: 'PENDING',
      createdAt: now,
      retriesAllowed: 0,
      retriesAttempted: 0
    }));
    stores.runs.save({
      id: runId, goal: 'budget', state: 'CREATED', createdAt: now, budget,
      taskGraph: { tasks, dependencies: [] }
    });
    return runId;
  }

  async function start(budget: ExecutionBudget | undefined, taskCount: number, agentCount = 1) {
    const runId = makeRun(budget, taskCount, agentCount);
    const supervisor = new Supervisor(okExecutor);
    try {
      await supervisor.startRun(runId);
      return { ok: true as const, runId };
    } catch (e: any) {
      return { ok: false as const, runId, error: e.message as string };
    }
  }

  // ---- maxTasks -------------------------------------------------------------
  describe('maxTasks', () => {
    it('undefined  -> unset, any number of tasks allowed', async () => {
      expect((await start(undefined, 5)).ok).toBe(true);
    });

    it('0          -> zero allowed, so any task is rejected', async () => {
      const r = await start({ maxTasks: 0 }, 3);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('BUDGET_EXCEEDED');
    });

    it('0 with an empty graph -> allowed', async () => {
      expect((await start({ maxTasks: 0 }, 0)).ok).toBe(true);
    });

    it('1 with 1 task  -> allowed (at the limit)', async () => {
      expect((await start({ maxTasks: 1 }, 1)).ok).toBe(true);
    });

    it('1 with 2 tasks -> rejected (limit + 1)', async () => {
      expect((await start({ maxTasks: 1 }, 2)).ok).toBe(false);
    });

    it('limit     -> allowed', async () => {
      expect((await start({ maxTasks: 4 }, 4)).ok).toBe(true);
    });

    it('limit + 1 -> rejected', async () => {
      expect((await start({ maxTasks: 4 }, 5)).ok).toBe(false);
    });

    it('negative  -> rejected as invalid, not silently ignored', async () => {
      const r = await start({ maxTasks: -5 }, 2);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('BUDGET_INVALID');
    });
  });

  // ---- maxAgents ------------------------------------------------------------
  // Behavioural note: maxAgents still doubles as the task concurrency limit.
  // That conflation is a known P1 defect, deliberately preserved in Phase A.
  describe('maxAgents', () => {
    it('undefined -> unset; concurrency falls back to the documented default', async () => {
      expect((await start(undefined, 3)).ok).toBe(true);
      expect(DEFAULT_MAX_CONCURRENCY).toBe(10);
    });

    it('0 with tasks -> zero allowed, so rejected', async () => {
      const r = await start({ maxAgents: 0 }, 3, 1);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('BUDGET_EXCEEDED');
    });

    it('1 with 1 agent definition  -> allowed (at the limit)', async () => {
      expect((await start({ maxAgents: 1 }, 4, 1)).ok).toBe(true);
    });

    it('1 with 2 agent definitions -> rejected (limit + 1)', async () => {
      expect((await start({ maxAgents: 1 }, 4, 2)).ok).toBe(false);
    });

    it('limit     -> allowed', async () => {
      expect((await start({ maxAgents: 3 }, 6, 3)).ok).toBe(true);
    });

    it('limit + 1 -> rejected', async () => {
      expect((await start({ maxAgents: 2 }, 6, 3)).ok).toBe(false);
    });

    it('negative  -> rejected as invalid', async () => {
      const r = await start({ maxAgents: -1 }, 2, 1);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('BUDGET_INVALID');
    });
  });

  // ---- maxRunDurationMs -----------------------------------------------------
  describe('maxRunDurationMs', () => {
    it('undefined -> no run-level deadline', async () => {
      const r = await start(undefined, 2);
      expect(r.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 80));
      expect(stores.runs.get(r.runId)!.state).toBe('COMPLETED');
    });

    it('0 -> a deadline of zero, so the run times out rather than being ignored', async () => {
      const runId = makeRun({ maxRunDurationMs: 0 }, 2);
      // startedAt must be in the past for elapsed > 0 to be observable.
      const run = stores.runs.get(runId)!;
      run.state = 'RUNNING';
      run.startedAt = new Date(Date.now() - 50).toISOString();
      stores.runs.save(run);

      const supervisor = new Supervisor(okExecutor);
      await supervisor.startRun(runId);
      await new Promise((res) => setTimeout(res, 120));
      expect(stores.runs.get(runId)!.state).toBe('TIMED_OUT');
      expect(stores.runs.get(runId)!.error).toBe('RUN_TIMEOUT');
    });

    it('a generous deadline -> run completes normally', async () => {
      const r = await start({ maxRunDurationMs: 60_000 }, 2);
      expect(r.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 100));
      expect(stores.runs.get(r.runId)!.state).toBe('COMPLETED');
    });

    it('negative -> rejected as invalid', async () => {
      const r = await start({ maxRunDurationMs: -1 }, 2);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('BUDGET_INVALID');
    });
  });

  // ---- unenforced fields: truthful status -----------------------------------
  describe('declared-but-unenforced budgets (truthful status)', () => {
    it('maxModelCalls / maxToolCalls / maxCostUsd are NOT enforced in Phase A', async () => {
      // Documenting reality rather than asserting an aspiration: these fields
      // exist on the schema but nothing accounts for them. Enforcement needs the
      // executor-boundary hooks planned for Phase G. If a later phase implements
      // them, this test should be replaced with real enforcement assertions.
      const r = await start({ maxModelCalls: 0, maxToolCalls: 0, maxCostUsd: 0 }, 3);
      expect(r.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 100));
      expect(stores.runs.get(r.runId)!.state).toBe('COMPLETED');
    });

    it('but negative values are still rejected structurally', async () => {
      const r = await start({ maxCostUsd: -0.01 }, 1);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('BUDGET_INVALID');
    });
  });
});
