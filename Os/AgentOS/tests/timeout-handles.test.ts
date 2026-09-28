import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Supervisor } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * A2: timeout handle leak.
 *
 * The audit measured 2400 executed tasks leaving 2400 live Timeout handles --
 * one per task, never cleared, each pinning the event loop for the full timeout
 * duration and blocking graceful shutdown. `clearTimeout` did not appear
 * anywhere in the source.
 *
 * The observable used here is Node's own active-resource table, which is the
 * same signal the audit used.
 */
function activeTimeoutHandles(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

describe('Timeout handle lifecycle (A2)', () => {
  const dbPath = testDbPath('timeout-handles');
  process.env.DATABASE_URL = dbPath;

  // Long enough that a leaked handle is still live when we measure.
  const LONG_TIMEOUT_MS = 120_000;
  let stores: Stores;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({
      id: 'th', version: '1', name: 'th', description: '', role: '', capabilities: []
    });
  });

  afterAll(() => {
    closeDb();
    removeDb(dbPath);
  });

  function makeRun(runId: string, count: number, timeoutMs: number | undefined, input?: unknown): void {
    const now = new Date().toISOString();
    const tasks: Task[] = Array.from({ length: count }, (_, i) => ({
      id: `${runId}#${i}`,
      runId,
      name: `t${i}`,
      description: '',
      agentDefinitionId: 'th',
      state: 'PENDING',
      createdAt: now,
      retriesAllowed: 0,
      retriesAttempted: 0,
      input,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    }));
    stores.runs.save({
      id: runId, goal: 'handles', state: 'CREATED', createdAt: now,
      budget: { maxAgents: 8 }, taskGraph: { tasks, dependencies: [] }
    });
  }

  async function drain(runId: string, budgetMs = 30_000): Promise<string> {
    const started = Date.now();
    for (;;) {
      const run = stores.runs.get(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run.state;
      if (Date.now() - started > budgetMs) return run.state;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('does not accumulate timeout handles across a large run that succeeds', async () => {
    const TASKS = 500;
    const executor: AgentExecutor = {
      async execute() {
        return { status: 'SUCCEEDED', output: 1 };
      }
    };

    makeRun('TH_OK', TASKS, LONG_TIMEOUT_MS);
    const before = activeTimeoutHandles();

    await new Supervisor(executor).startRun('TH_OK');
    const state = await drain('TH_OK');
    expect(state).toBe('COMPLETED');

    const after = activeTimeoutHandles();
    const leaked = after - before;

    // Pre-fix behaviour was leaked === TASKS (one live handle per task).
    // A handful of transient handles from the polling loop is expected; a
    // per-task leak is not.
    expect(leaked).toBeLessThan(10);
    expect(leaked).toBeLessThan(TASKS / 10);
  });

  it('clears the handle when the executor fails', async () => {
    const executor: AgentExecutor = {
      async execute() {
        return { status: 'FAILED', error: 'intentional' };
      }
    };
    makeRun('TH_FAIL', 50, LONG_TIMEOUT_MS);
    const before = activeTimeoutHandles();
    await new Supervisor(executor).startRun('TH_FAIL');
    await drain('TH_FAIL');
    expect(activeTimeoutHandles() - before).toBeLessThan(10);
  });

  it('clears the handle when the executor throws', async () => {
    const executor: AgentExecutor = {
      async execute() {
        throw new Error('boom');
      }
    };
    makeRun('TH_THROW', 50, LONG_TIMEOUT_MS);
    const before = activeTimeoutHandles();
    await new Supervisor(executor).startRun('TH_THROW');
    await drain('TH_THROW');
    expect(activeTimeoutHandles() - before).toBeLessThan(10);
  });

  it('clears the handle on the timeout path itself', async () => {
    // Task timeout fires first; the executor resolves later. Both the timeout
    // timer and the task must settle without leaving a live handle behind.
    const executor: AgentExecutor = {
      async execute() {
        await new Promise((r) => setTimeout(r, 120));
        return { status: 'SUCCEEDED', output: 'late' };
      }
    };
    makeRun('TH_TO', 10, 20);
    const before = activeTimeoutHandles();
    await new Supervisor(executor).startRun('TH_TO');
    await drain('TH_TO');

    const tasks = stores.tasks.listByRun('TH_TO');
    expect(tasks.some((t) => t.state === 'TIMED_OUT')).toBe(true);

    // Allow the executor's own late timer to retire.
    await new Promise((r) => setTimeout(r, 250));
    expect(activeTimeoutHandles() - before).toBeLessThan(10);
  });

  it('a run with no timeoutMs creates no timeout handles at all', async () => {
    const executor: AgentExecutor = {
      async execute() {
        return { status: 'SUCCEEDED', output: 1 };
      }
    };
    makeRun('TH_NONE', 200, undefined);
    const before = activeTimeoutHandles();
    await new Supervisor(executor).startRun('TH_NONE');
    expect(await drain('TH_NONE')).toBe('COMPLETED');
    expect(activeTimeoutHandles() - before).toBeLessThan(10);
  });
});
