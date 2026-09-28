import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Supervisor } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * B9: start / resume / recover are three distinct operations.
 *
 * v0.1 routed all three through startRun, which "recovered" by resetting every
 * RUNNING task to READY. Calling start twice therefore re-executed in-flight
 * work -- a double-clicked button duplicated the run.
 */
describe('Start / resume / recover semantics (B9)', () => {
  const dbPath = testDbPath('lifecycle');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'lw', version: '1', name: 'lw', description: '', role: '', capabilities: [] });
  });

  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  function makeRun(count: number, opts: { delayMs?: number } = {}): string {
    const runId = `LC${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const tasks: Task[] = Array.from({ length: count }, (_, i) => ({
      id: `T${i}`, runId, name: `T${i}`, description: '', agentDefinitionId: 'lw',
      state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0,
      input: opts.delayMs ? { delayMs: opts.delayMs } : undefined
    }));
    stores.runs.save({ id: runId, goal: 'lifecycle', state: 'CREATED', createdAt: now, taskGraph: { tasks, dependencies: [] } });
    return runId;
  }

  function countingExecutor(counts: Map<string, number>, delayMs = 0): AgentExecutor {
    return {
      async execute(_agent, task) {
        const key = `${task.runId}/${task.id}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return { status: 'SUCCEEDED', output: 1 };
      }
    };
  }

  const settle = async (runId: string, ms = 5_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const run = stores.runs.get(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;
      if (Date.now() > deadline) return run;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  // ---- double start --------------------------------------------------------
  it('calling start twice does NOT redispatch in-flight work', async () => {
    const runId = makeRun(4, { delayMs: 120 });
    const counts = new Map<string, number>();
    const sup = new Supervisor(countingExecutor(counts, 120), { stores, leaseMs: 60_000 });

    await sup.startRun(runId);
    await new Promise((r) => setTimeout(r, 30));  // work now in flight
    await sup.startRun(runId);                    // the v0.1 duplication trigger
    await sup.startRun(runId);

    await settle(runId);
    sup.close();

    for (const [key, n] of counts) {
      expect(n, `${key} executed ${n} times`).toBe(1);
    }
    expect(counts.size).toBe(4);
    for (const t of stores.tasks.listByRun(runId)) expect(t.attempt).toBe(1);
  });

  it('start on a CREATED run is accepted; a second concurrent start cannot double-admit', async () => {
    const runId = makeRun(3);
    const counts = new Map<string, number>();
    const a = new Supervisor(countingExecutor(counts), { stores, workerId: 'w-A', leaseMs: 60_000 });
    const b = new Supervisor(countingExecutor(counts), { stores, workerId: 'w-B', leaseMs: 60_000 });

    await Promise.all([a.startRun(runId), b.startRun(runId)]);
    await settle(runId);
    a.close(); b.close();

    expect(stores.runs.get(runId)!.state).toBe('COMPLETED');
    for (const [, n] of counts) expect(n).toBe(1);
    // Exactly one run.started event: only one caller won the CREATED -> RUNNING CAS.
    const started = stores.events.listByRun(runId).filter((e) => e.type === 'run.started');
    expect(started).toHaveLength(1);
  });

  it('start after a terminal state is rejected', async () => {
    const runId = makeRun(1);
    const sup = new Supervisor(countingExecutor(new Map()), { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await settle(runId);
    await expect(sup.startRun(runId)).rejects.toThrow('INVALID_STATE_TRANSITION');
    sup.close();
  });

  // ---- resume is not start, and not recovery -------------------------------
  it('start on a PAUSED run is refused and points at resume', async () => {
    const runId = makeRun(3, { delayMs: 60 });
    const sup = new Supervisor(countingExecutor(new Map(), 60), { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await sup.pauseRun(runId);

    await expect(sup.startRun(runId)).rejects.toThrow('use resumeRun');
    sup.close();
  });

  it('resume on a run that was never paused is refused', async () => {
    const runId = makeRun(2);
    const sup = new Supervisor(countingExecutor(new Map()), { stores, leaseMs: 60_000 });
    await expect(sup.resumeRun(runId)).rejects.toThrow('run is not paused');
    sup.close();
  });

  it('resume drains a paused run to completion without re-running finished work', async () => {
    const runId = makeRun(4, { delayMs: 50 });
    const counts = new Map<string, number>();
    const sup = new Supervisor(countingExecutor(counts, 50), { stores, leaseMs: 60_000 });

    await sup.startRun(runId);
    await new Promise((r) => setTimeout(r, 20));
    await sup.pauseRun(runId);
    // Let in-flight work settle so the run reaches PAUSED.
    await new Promise((r) => setTimeout(r, 200));
    expect(['PAUSING', 'PAUSED']).toContain(stores.runs.get(runId)!.state);

    await sup.resumeRun(runId);
    const run = await settle(runId);
    sup.close();

    expect(run.state).toBe('COMPLETED');
    for (const [key, n] of counts) expect(n, `${key} ran ${n}x`).toBe(1);
  });

  it('a run stuck in PAUSING after a crash is still resumable (Phase A trap state closed)', async () => {
    const runId = makeRun(2);
    // Simulate a process dying mid-pause: the row is durably PAUSING and no
    // worker is alive. In v0.1 nothing accepted this state and the run was lost.
    stores.runs.save({ ...stores.runs.get(runId)!, state: 'PAUSING' });
    expect(stores.runs.get(runId)!.state).toBe('PAUSING');

    const counts = new Map<string, number>();
    const sup = new Supervisor(countingExecutor(counts), { stores, leaseMs: 60_000 });
    await sup.resumeRun(runId);
    const run = await settle(runId);
    sup.close();

    expect(run.state).toBe('COMPLETED');
  });

  // ---- recover is lease-based ---------------------------------------------
  it('recover refuses a run that is not running', async () => {
    const runId = makeRun(1);
    const sup = new Supervisor(countingExecutor(new Map()), { stores, leaseMs: 60_000 });
    await expect(sup.recoverRun(runId)).rejects.toThrow('only a running run can be recovered');
    sup.close();
  });

  it('recover does NOT steal work held under a live lease', async () => {
    const runId = makeRun(3, { delayMs: 400 });
    const counts = new Map<string, number>();
    const healthy = new Supervisor(countingExecutor(counts, 400), { stores, workerId: 'healthy', leaseMs: 60_000 });
    const arriving = new Supervisor(countingExecutor(counts, 400), { stores, workerId: 'arriving', leaseMs: 60_000 });

    await healthy.startRun(runId);
    await new Promise((r) => setTimeout(r, 60));
    const ownedBefore = stores.tasks.listByRun(runId).filter((t) => t.state === 'RUNNING');
    expect(ownedBefore.length).toBeGreaterThan(0);

    // A second worker arrives and tries to adopt the run.
    await arriving.recoverRun(runId);

    const ownedAfter = stores.tasks.listByRun(runId).filter((t) => t.state === 'RUNNING');
    for (const t of ownedAfter) {
      expect(t.ownerId).toBe('healthy');
      expect(t.attempt).toBe(1);
    }

    await settle(runId, 8_000);
    healthy.close(); arriving.close();
    for (const [key, n] of counts) expect(n, `${key} ran ${n}x`).toBe(1);
  });

  it('recover reclaims work whose lease HAS expired', async () => {
    const runId = makeRun(2);
    const now = Date.now();
    // A dead worker's claim: RUNNING, owned, lease already in the past.
    stores.tasks.setState({ runId, taskId: 'T0' }, 'READY');
    const dead = stores.tasks.claim({ runId, taskId: 'T0', workerId: 'dead-worker', leaseMs: 10, now: now - 10_000 })!;
    expect(dead.fence).toBe(1);
    stores.runs.compareAndSetState(runId, ['CREATED'], 'RUNNING', { startedAt: new Date(now).toISOString() });

    const counts = new Map<string, number>();
    const rescuer = new Supervisor(countingExecutor(counts), { stores, workerId: 'rescuer', leaseMs: 60_000 });
    await rescuer.recoverRun(runId);
    const run = await settle(runId, 8_000);
    rescuer.close();

    const t0 = stores.tasks.get({ runId, taskId: 'T0' })!;
    expect(t0.state).toBe('SUCCEEDED');
    expect(t0.fence).toBe(2);       // reclaimed -> fence advanced
    expect(t0.attempt).toBe(2);     // attempt monotonic across the reclaim
    expect(run.state).toBe('COMPLETED');
  });
});
