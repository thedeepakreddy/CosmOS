import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Supervisor, retryDelayMs, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from '../src/engine/Supervisor';
import { validateExecutorResult } from '../src/engine/executorResult';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase C: retry policy and the executor result contract.
 *
 * The audit measured inter-attempt gaps of 0-2ms (a hot loop against whatever
 * just failed), found TIMED_OUT silently ignoring retriesAllowed, and found
 * malformed executor results producing a FAILED task with a NULL error.
 */
describe('Retry policy and executor contract (Phase C)', () => {
  const dbPath = testDbPath('retry-policy');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'rp', version: '1', name: 'rp', description: '', role: '', capabilities: [] });
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  function makeRun(extra: Partial<Task> = {}): string {
    const runId = `RP${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'retry', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: [{
          id: 'T', runId, name: 'T', description: '', agentDefinitionId: 'rp',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0, ...extra
        }],
        dependencies: []
      }
    });
    return runId;
  }

  const settle = async (runId: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const run = stores.runs.get(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;
      if (Date.now() > deadline) return run;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  // ---- backoff shape -------------------------------------------------------
  describe('backoff (B / P1-8)', () => {
    it('grows exponentially and is capped', () => {
      // random()=1 gives the top of the jitter window, i.e. the full delay.
      const top = (n: number) => retryDelayMs(n, () => 0.999999);
      expect(top(1)).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS - 1);
      expect(top(2)).toBeGreaterThan(top(1));
      expect(top(3)).toBeGreaterThan(top(2));
      expect(top(50)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    });

    it('carries jitter, so a wave of failures does not retry in lockstep', () => {
      const samples = new Set(Array.from({ length: 50 }, () => retryDelayMs(4)));
      expect(samples.size).toBeGreaterThan(5);
      for (const v of samples) {
        const capped = Math.min(RETRY_BASE_DELAY_MS * 8, RETRY_MAX_DELAY_MS);
        expect(v).toBeGreaterThanOrEqual(Math.floor(capped / 2));
        expect(v).toBeLessThanOrEqual(capped);
      }
    });

    it('a real retry actually waits: measured gaps are no longer ~0ms', async () => {
      const runId = makeRun({ retriesAllowed: 3 });
      const at: number[] = [];
      const sup = new Supervisor(
        { async execute() { at.push(Date.now()); return { status: 'FAILED', error: 'always' }; } },
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(at).toHaveLength(4); // retriesAllowed = 3 -> 4 executions
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      // v0.1 measured 0-2ms here. Every gap must now clear the first backoff floor.
      for (const g of gaps) expect(g).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS / 2);
      // And the delay grows.
      expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
    });

    it('backoff is durable: a task in its window cannot be claimed by ANY worker', async () => {
      const runId = makeRun({ retriesAllowed: 2 });
      const sup = new Supervisor(
        { async execute() { return { status: 'FAILED', error: 'x' }; } },
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      // Catch it mid-backoff.
      await new Promise((r) => setTimeout(r, 20));
      const t = stores.tasks.get({ runId, taskId: 'T' })!;
      if (t.state === 'READY' && t.notBefore && t.notBefore > Date.now()) {
        const stolen = stores.tasks.claim({
          runId, taskId: 'T', workerId: 'other-worker', leaseMs: 60_000, now: Date.now()
        });
        expect(stolen, 'a task inside its backoff window must not be claimable').toBeNull();
      }
      await settle(runId);
      sup.close();
      expect(stores.runs.get(runId)!.state).toBe('FAILED');
    });
  });

  // ---- retry arithmetic preserved -----------------------------------------
  it('retriesAllowed = N still yields exactly N+1 executions (Phase A/B preserved)', async () => {
    for (const retries of [0, 1, 2, 3]) {
      const runId = makeRun({ retriesAllowed: retries });
      let n = 0;
      const sup = new Supervisor(
        { async execute() { n++; return { status: 'FAILED', error: 'always' }; } },
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(n, `retriesAllowed=${retries}`).toBe(retries + 1);
      const t = stores.tasks.get({ runId, taskId: 'T' })!;
      expect(t.retriesAttempted).toBe(retries);
      expect(t.attempt).toBe(retries + 1);
      expect(t.state).toBe('FAILED');
    }
  });

  it('a transient failure that later succeeds stops retrying', async () => {
    const runId = makeRun({ retriesAllowed: 5 });
    let n = 0;
    const sup = new Supervisor(
      { async execute() { n++; return n < 3 ? { status: 'FAILED', error: 't' } : { status: 'SUCCEEDED', output: n }; } },
      { stores, leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    await settle(runId);
    sup.close();

    expect(n).toBe(3);
    const t = stores.tasks.get({ runId, taskId: 'T' })!;
    expect(t.state).toBe('SUCCEEDED');
    expect(t.output).toBe(3);
    expect(t.retriesAttempted).toBe(2);
    expect(t.notBefore).toBeUndefined();
  });

  // ---- timeouts are retryable ---------------------------------------------
  it('a TIMED_OUT task now honours retriesAllowed (was silently ignored)', async () => {
    const runId = makeRun({ retriesAllowed: 2, timeoutMs: 40 });
    let n = 0;
    const sup = new Supervisor(
      { async execute() { n++; await new Promise((r) => setTimeout(r, 400)); return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    await settle(runId);
    sup.close();

    expect(n, 'timeout must consume the retry budget').toBe(3); // 1 + 2 retries
    const t = stores.tasks.get({ runId, taskId: 'T' })!;
    expect(t.state).toBe('TIMED_OUT');
    expect(t.retriesAttempted).toBe(2);
  });

  it('a timeout that succeeds on retry completes the run', async () => {
    const runId = makeRun({ retriesAllowed: 3, timeoutMs: 60 });
    let n = 0;
    const sup = new Supervisor(
      { async execute() { n++; if (n === 1) await new Promise((r) => setTimeout(r, 400)); return { status: 'SUCCEEDED', output: n }; } },
      { stores, leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    const run = await settle(runId);
    sup.close();

    expect(run.state).toBe('COMPLETED');
    expect(stores.tasks.get({ runId, taskId: 'T' })!.state).toBe('SUCCEEDED');
  });

  it('the timeout aborts the executor, not just the supervisor\'s wait', async () => {
    const runId = makeRun({ timeoutMs: 50 });
    let aborted = false;
    const executor: AgentExecutor = {
      async execute(_a, _t, ctx) {
        await new Promise<void>((resolve) => {
          const done = setTimeout(resolve, 2_000);
          ctx.signal.addEventListener('abort', () => { aborted = true; clearTimeout(done); resolve(); });
        });
        return { status: 'SUCCEEDED', output: 'late' };
      }
    };
    const sup = new Supervisor(executor, { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await settle(runId);
    sup.close();

    expect(aborted, 'a timeout must abort the executor').toBe(true);
    expect(stores.tasks.get({ runId, taskId: 'T' })!.state).toBe('TIMED_OUT');
  });

  // ---- executor result contract -------------------------------------------
  describe('executor result contract', () => {
    const cases: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['a string', 'done'],
      ['{}', {}],
      ['{status:"WAT"}', { status: 'WAT' }],
      ['{status:"FAILED", error: 5}', { status: 'FAILED', error: 5 }]
    ];

    for (const [label, value] of cases) {
      it(`rejects ${label} with a diagnostic, not a null error`, () => {
        const check = validateExecutorResult(value);
        expect(check.ok).toBe(false);
        if (!check.ok) expect(check.error).toMatch(/EXECUTOR_CONTRACT_VIOLATION/);
      });
    }

    it('accepts well-formed results', () => {
      expect(validateExecutorResult({ status: 'SUCCEEDED', output: 1 }).ok).toBe(true);
      expect(validateExecutorResult({ status: 'FAILED', error: 'x' }).ok).toBe(true);
      expect(validateExecutorResult({ status: 'FAILED' }).ok).toBe(true);
    });

    it('a malformed result reaches the task as a readable error', async () => {
      const runId = makeRun();
      const sup = new Supervisor(
        { async execute() { return 42 as never; } },
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      const t = stores.tasks.get({ runId, taskId: 'T' })!;
      expect(t.state).toBe('FAILED');
      expect(t.error).toMatch(/EXECUTOR_CONTRACT_VIOLATION/);
      expect(t.error).toBeTruthy();   // v0.1 left this null
    });

    it('a FAILED result with no error message still gets one', async () => {
      const runId = makeRun();
      const sup = new Supervisor(
        { async execute() { return { status: 'FAILED' }; } },
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();
      expect(stores.tasks.get({ runId, taskId: 'T' })!.error).toBe('EXECUTOR_REPORTED_FAILURE');
    });
  });
});
