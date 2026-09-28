import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Supervisor } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task, isTerminalTaskState } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase C: cancellation and terminal-state integrity.
 *
 * The audit's P0-5: cancelRun flipped one row and returned. No signal reached
 * the executor -- `AbortSignal` did not appear anywhere in the codebase -- so
 * cancelled work ran to completion and persisted SUCCEEDED into a CANCELLED
 * run, while its sibling sat at PENDING forever.
 */
describe('Cancellation and terminal integrity (Phase C)', () => {
  const dbPath = testDbPath('cancellation');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'cw', version: '1', name: 'cw', description: '', role: '', capabilities: [] });
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  function makeRun(ids: string[], extra: Partial<Task> = {}): string {
    const runId = `CX${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'cancel', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: ids.map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'cw',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0, ...extra
        })),
        dependencies: []
      }
    });
    return runId;
  }

  // ---- the audit's exact scenario ------------------------------------------
  it('cancelling a run aborts in-flight work and nothing resurrects', async () => {
    const runId = makeRun(['LONG', 'AFTER']);
    let sawSignal = false;
    let abortedDuringExecution = false;
    let completedAnyway = false;

    const executor: AgentExecutor = {
      async execute(_agent, _task, ctx) {
        sawSignal = ctx.signal !== undefined;
        await new Promise<void>((resolve) => {
          const done = setTimeout(() => { completedAnyway = true; resolve(); }, 3_000);
          ctx.signal.addEventListener('abort', () => {
            abortedDuringExecution = true;
            clearTimeout(done);
            resolve();
          });
        });
        if (ctx.signal.aborted) return { status: 'FAILED', error: 'aborted' };
        return { status: 'SUCCEEDED', output: 'work done after cancel' };
      }
    };

    const sup = new Supervisor(executor, { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await new Promise((r) => setTimeout(r, 80));
    expect(stores.tasks.get({ runId, taskId: 'LONG' })!.state).toBe('RUNNING');

    await sup.cancelRun(runId);

    // The executor was actually told to stop.
    expect(sawSignal).toBe(true);
    expect(abortedDuringExecution).toBe(true);
    expect(completedAnyway).toBe(false);

    expect(stores.runs.get(runId)!.state).toBe('CANCELLED');

    // Give any late write every chance to land.
    await new Promise((r) => setTimeout(r, 400));
    sup.close();

    const tasks = stores.tasks.listByRun(runId);
    // No task is left non-terminal, and nothing became SUCCEEDED.
    for (const t of tasks) {
      expect(isTerminalTaskState(t.state), `${t.id} is ${t.state}`).toBe(true);
      expect(t.state).not.toBe('SUCCEEDED');
      expect(t.ownerId).toBeUndefined();
    }
    expect(tasks.find((t) => t.id === 'AFTER')!.state).toBe('CANCELLED');
    expect(stores.runs.get(runId)!.state).toBe('CANCELLED');
  });

  it('an executor that IGNORES the signal still cannot write into a cancelled run', async () => {
    const runId = makeRun(['STUBBORN']);
    let finished = false;
    const executor: AgentExecutor = {
      async execute() {
        await new Promise((r) => setTimeout(r, 300)); // ignores ctx.signal entirely
        finished = true;
        return { status: 'SUCCEEDED', output: 'late success' };
      }
    };
    const sup = new Supervisor(executor, { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await new Promise((r) => setTimeout(r, 60));
    await sup.cancelRun(runId);

    await new Promise((r) => setTimeout(r, 500));
    sup.close();

    expect(finished).toBe(true); // it really did run to completion
    const t = stores.tasks.get({ runId, taskId: 'STUBBORN' })!;
    expect(t.state).toBe('CANCELLED');   // ...and its result was rejected
    expect(t.output).toBeUndefined();
    const discarded = stores.events.listByRun(runId).filter((e) => e.type === 'task.result.discarded');
    expect(discarded.length).toBeGreaterThan(0);
  });

  it('cancel is idempotent and cancelling a finished run does not disturb it', async () => {
    const runId = makeRun(['Q']);
    const sup = new Supervisor(
      { async execute() { return { status: 'SUCCEEDED', output: 'ok' }; } },
      { stores, leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    for (let i = 0; i < 40 && stores.runs.get(runId)!.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stores.runs.get(runId)!.state).toBe('COMPLETED');

    await sup.cancelRun(runId);
    await sup.cancelRun(runId);
    sup.close();

    expect(stores.runs.get(runId)!.state).toBe('COMPLETED');
    expect(stores.tasks.get({ runId, taskId: 'Q' })!.state).toBe('SUCCEEDED');
    expect(stores.tasks.get({ runId, taskId: 'Q' })!.output).toBe('ok');
  });

  // ---- terminal draining ---------------------------------------------------
  it('a failing task drains every sibling: no task is left non-terminal', async () => {
    const runId = makeRun(['F0', 'F1', 'F2', 'F3', 'F4', 'F5']);
    const executor: AgentExecutor = {
      async execute(_a, task) {
        if (task.id === 'F0') return { status: 'FAILED', error: 'boom' };
        await new Promise((r) => setTimeout(r, 200));
        return { status: 'SUCCEEDED', output: 1 };
      }
    };
    const sup = new Supervisor(executor, { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    for (let i = 0; i < 60 && stores.runs.get(runId)!.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 400));
    sup.close();

    expect(stores.runs.get(runId)!.state).toBe('FAILED');
    const tasks = stores.tasks.listByRun(runId);
    expect(tasks).toHaveLength(6);
    for (const t of tasks) {
      expect(isTerminalTaskState(t.state), `${t.id} left at ${t.state}`).toBe(true);
      expect(t.ownerId).toBeUndefined();
      expect(t.leaseExpiresAt).toBeUndefined();
    }
    const failed = stores.events.listByRun(runId).find((e) => e.type === 'run.failed');
    expect((failed!.payload as { tasksDrained: number }).tasksDrained).toBeGreaterThan(0);
  });

  it('a task cannot be claimed once its run is terminal', async () => {
    const runId = makeRun(['C1', 'C2']);
    const sup = new Supervisor({ async execute() { return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await sup.cancelRun(runId);
    sup.close();

    // Every task is terminal, so the claim's state predicate cannot match.
    for (const id of ['C1', 'C2']) {
      expect(stores.tasks.claim({
        runId, taskId: id, workerId: 'latecomer', leaseMs: 60_000, now: Date.now()
      })).toBeNull();
    }
  });

  // ---- run-level timeout ---------------------------------------------------
  it('a run-level timeout drains and aborts too', async () => {
    const runId = `CT${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'run timeout', state: 'CREATED', createdAt: now,
      budget: { maxRunDurationMs: 50 },
      taskGraph: {
        tasks: ['R1', 'R2'].map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'cw',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    });
    // startedAt in the past so the deadline is already breached.
    stores.runs.compareAndSetState(runId, ['CREATED'], 'RUNNING', {
      startedAt: new Date(Date.now() - 500).toISOString()
    });

    const sup = new Supervisor({ async execute() { return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 60_000 });
    await sup.recoverRun(runId);
    await new Promise((r) => setTimeout(r, 150));
    sup.close();

    expect(stores.runs.get(runId)!.state).toBe('TIMED_OUT');
    for (const t of stores.tasks.listByRun(runId)) {
      expect(isTerminalTaskState(t.state)).toBe(true);
    }
  });
});
