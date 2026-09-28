import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Supervisor } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb, getDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * B25: ownership under injected failure.
 *
 * Cases already covered elsewhere and deliberately not duplicated here:
 *   worker SIGKILL + reclaim  -> multiprocess.test.ts
 *   stale completion/failure/heartbeat -> claim-protocol.test.ts
 *   duplicate start -> lifecycle.test.ts
 */
describe('Failure injection vs ownership (B25)', () => {
  const dbPath = testDbPath('failure-injection');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'fi', version: '1', name: 'fi', description: '', role: '', capabilities: [] });
  });

  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  function makeRun(count: number, retriesAllowed = 0): string {
    const runId = `FI${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const tasks: Task[] = Array.from({ length: count }, (_, i) => ({
      id: `T${i}`, runId, name: `T${i}`, description: '', agentDefinitionId: 'fi',
      state: 'PENDING', createdAt: now, retriesAllowed, retriesAttempted: 0
    }));
    stores.runs.save({ id: runId, goal: 'fi', state: 'CREATED', createdAt: now, taskGraph: { tasks, dependencies: [] } });
    return runId;
  }

  const settle = async (runId: string, ms = 8_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const run = stores.runs.get(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;
      if (Date.now() > deadline) return run;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('an executor failure releases the lease and leaves no owner behind', async () => {
    const runId = makeRun(3);
    const sup = new Supervisor(
      { async execute() { return { status: 'FAILED', error: 'injected' }; } },
      { stores, leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    const run = await settle(runId);
    sup.close();

    expect(run.state).toBe('FAILED');
    for (const t of stores.tasks.listByRun(runId)) {
      expect(t.ownerId).toBeUndefined();
      expect(t.leaseExpiresAt).toBeUndefined();
    }
  });

  it('a throwing executor still releases ownership', async () => {
    const runId = makeRun(2);
    const sup = new Supervisor(
      { async execute() { throw new Error('boom'); } },
      { stores, leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    await settle(runId);
    sup.close();
    for (const t of stores.tasks.listByRun(runId)) expect(t.ownerId).toBeUndefined();
  });

  it('retry arithmetic is preserved under ownership: retriesAllowed=N gives N+1 executions', async () => {
    for (const retries of [0, 1, 2, 3]) {
      const runId = makeRun(1, retries);
      let invocations = 0;
      const sup = new Supervisor(
        { async execute() { invocations++; return { status: 'FAILED', error: 'always' }; } },
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(invocations, `retriesAllowed=${retries}`).toBe(retries + 1);
      const t = stores.tasks.get({ runId, taskId: 'T0' })!;
      expect(t.retriesAttempted).toBe(retries);
      // `attempt` counts every execution, so it tracks the invocation count.
      expect(t.attempt).toBe(retries + 1);
      expect(t.state).toBe('FAILED');
    }
  });

  it('rapid repeated resume requests do not duplicate execution', async () => {
    const runId = makeRun(4);
    const counts = new Map<string, number>();
    const executor: AgentExecutor = {
      async execute(_a, task) {
        counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 60));
        return { status: 'SUCCEEDED', output: 1 };
      }
    };
    const sup = new Supervisor(executor, { stores, leaseMs: 60_000 });

    await sup.startRun(runId);
    await new Promise((r) => setTimeout(r, 20));
    await sup.pauseRun(runId);
    await new Promise((r) => setTimeout(r, 120));

    // Hammer resume.
    await Promise.all(Array.from({ length: 12 }, () => sup.resumeRun(runId).catch(() => undefined)));
    await settle(runId);
    sup.close();

    for (const [id, n] of counts) expect(n, `${id} ran ${n}x`).toBe(1);
    expect(counts.size).toBe(4);
  });

  it('interleaved start/resume/recover storms cannot duplicate work', async () => {
    const runId = makeRun(6);
    const counts = new Map<string, number>();
    const executor: AgentExecutor = {
      async execute(_a, task) {
        counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 40));
        return { status: 'SUCCEEDED', output: 1 };
      }
    };
    const a = new Supervisor(executor, { stores, workerId: 'storm-A', leaseMs: 60_000 });
    const b = new Supervisor(executor, { stores, workerId: 'storm-B', leaseMs: 60_000 });

    await a.startRun(runId);
    await Promise.all([
      ...Array.from({ length: 8 }, () => a.startRun(runId).catch(() => undefined)),
      ...Array.from({ length: 8 }, () => b.startRun(runId).catch(() => undefined)),
      ...Array.from({ length: 8 }, () => b.recoverRun(runId).catch(() => undefined)),
      ...Array.from({ length: 8 }, () => a.resumeRun(runId).catch(() => undefined))
    ]);
    await settle(runId);
    a.close(); b.close();

    for (const [id, n] of counts) expect(n, `${id} ran ${n}x`).toBe(1);
    expect(stores.runs.get(runId)!.state).toBe('COMPLETED');
    for (const t of stores.tasks.listByRun(runId)) expect(t.attempt).toBe(1);
  });

  it('a busy database does not corrupt ownership: the claim either wins or loses cleanly', async () => {
    const runId = makeRun(1);
    stores.tasks.setState({ runId, taskId: 'T0' }, 'READY');

    // Hold an exclusive write lock from a SECOND connection to the same file.
    const blocker = new Database(dbPath);
    blocker.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');

    // Our connection cannot get the write lock; the claim must fail loudly
    // rather than half-apply.
    getDb().pragma('busy_timeout = 150');
    let threw: string | null = null;
    let ticket = null;
    try {
      ticket = stores.tasks.claim({ runId, taskId: 'T0', workerId: 'blocked', leaseMs: 60_000, now: Date.now() });
    } catch (e: any) {
      threw = e.code ?? e.message;
    }
    expect(ticket).toBeNull();
    expect(threw).toMatch(/SQLITE_BUSY/);

    // Nothing was written: the task is untouched and still claimable.
    blocker.exec('ROLLBACK');
    blocker.close();
    getDb().pragma('busy_timeout = 10000');

    const after = stores.tasks.get({ runId, taskId: 'T0' })!;
    expect(after.state).toBe('READY');
    expect(after.ownerId).toBeUndefined();
    expect(after.fence).toBe(0);
    expect(after.attempt).toBe(0);

    // And once the lock clears, the claim succeeds normally.
    const recovered = stores.tasks.claim({ runId, taskId: 'T0', workerId: 'after', leaseMs: 60_000, now: Date.now() });
    expect(recovered).not.toBeNull();
    expect(recovered!.fence).toBe(1);
  });

  it('a task that keeps killing its worker is eventually failed, not retried forever (B11)', async () => {
    const runId = makeRun(1);
    const now = Date.now();
    stores.tasks.setState({ runId, taskId: 'T0' }, 'READY');

    // Simulate repeated worker deaths: claim, never complete, let the lease lapse.
    // retriesAllowed=0 -> maxAttempts = 0 + 1 + MAX_RECLAIM_ATTEMPTS(3) = 4.
    for (let i = 0; i < 4; i++) {
      const t = stores.tasks.claim({ runId, taskId: 'T0', workerId: `dead-${i}`, leaseMs: 10, now: now + i * 1000 });
      expect(t, `reclaim ${i} should have been granted`).not.toBeNull();
    }
    expect(stores.tasks.get({ runId, taskId: 'T0' })!.attempt).toBe(4);

    stores.runs.compareAndSetState(runId, ['CREATED'], 'RUNNING', { startedAt: new Date(now).toISOString() });

    let executed = 0;
    const sup = new Supervisor(
      { async execute() { executed++; return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, workerId: 'final', leaseMs: 60_000 }
    );
    await sup.recoverRun(runId);
    const run = await settle(runId);
    sup.close();

    // The 5th claim exceeds the cap, so the task is failed WITHOUT executing.
    expect(executed).toBe(0);
    const t = stores.tasks.get({ runId, taskId: 'T0' })!;
    expect(t.state).toBe('FAILED');
    expect(t.error).toMatch(/ATTEMPT_LIMIT_EXCEEDED/);
    expect(t.attempt).toBe(5);
    expect(run.state).toBe('FAILED');
  });
});
