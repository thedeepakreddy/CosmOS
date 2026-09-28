import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores, ClaimTicket } from '../src/persistence/contracts';
import { Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase B: the ownership protocol, exercised directly against real SQLite.
 *
 * The claim-race case (B16) uses real OS processes: better-sqlite3 is
 * synchronous, so "concurrent" claims inside one process would be serialised by
 * the event loop and would prove nothing about contention.
 */
const CLAIM_WORKER = path.join(__dirname, 'fixtures', 'claim-worker.js');

describe('Claim / lease / fencing protocol (B4-B7, B16, B17)', () => {
  const dbPath = testDbPath('claim-protocol');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({
      id: 'w', version: '1', name: 'w', description: '', role: '', capabilities: []
    });
  });

  afterAll(() => {
    closeDb();
    removeDb(dbPath);
  });

  beforeEach(() => { seq++; });

  function makeRun(taskIds: string[], state: Task['state'] = 'READY'): string {
    const runId = `CP${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'claim', state: 'RUNNING', createdAt: now, startedAt: now,
      taskGraph: {
        tasks: taskIds.map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'w',
          state, createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    });
    return runId;
  }

  // ---- B4: atomic claim ---------------------------------------------------
  describe('atomic claim (B4)', () => {
    it('a READY task can be claimed exactly once; the second attempt loses', () => {
      const runId = makeRun(['T']);
      const first = stores.tasks.claim({ runId, taskId: 'T', workerId: 'worker-A', leaseMs: 60_000, now: Date.now() });
      const second = stores.tasks.claim({ runId, taskId: 'T', workerId: 'worker-B', leaseMs: 60_000, now: Date.now() });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(first!.workerId).toBe('worker-A');

      const task = stores.tasks.get({ runId, taskId: 'T' })!;
      expect(task.state).toBe('RUNNING');
      expect(task.ownerId).toBe('worker-A');
      expect(task.fence).toBe(1);
      expect(task.attempt).toBe(1);
    });

    it('a PENDING task cannot be claimed at all', () => {
      const runId = makeRun(['P'], 'PENDING');
      expect(stores.tasks.claim({ runId, taskId: 'P', workerId: 'w1', leaseMs: 60_000, now: Date.now() })).toBeNull();
    });

    it('claiming increments fence and attempt monotonically (B11)', () => {
      const runId = makeRun(['M']);
      const now = Date.now();
      const t1 = stores.tasks.claim({ runId, taskId: 'M', workerId: 'w1', leaseMs: 100, now })!;
      // Lease expired -> reclaimable.
      const t2 = stores.tasks.claim({ runId, taskId: 'M', workerId: 'w2', leaseMs: 100, now: now + 500 })!;
      const t3 = stores.tasks.claim({ runId, taskId: 'M', workerId: 'w3', leaseMs: 100, now: now + 1000 })!;

      expect([t1.fence, t2.fence, t3.fence]).toEqual([1, 2, 3]);
      expect([t1.attempt, t2.attempt, t3.attempt]).toEqual([1, 2, 3]);
    });
  });

  // ---- B8: healthy owner protection --------------------------------------
  describe('healthy-owner protection (B8)', () => {
    it('a live lease cannot be stolen, no matter how many workers try', () => {
      const runId = makeRun(['H']);
      const now = Date.now();
      const owner = stores.tasks.claim({ runId, taskId: 'H', workerId: 'healthy', leaseMs: 60_000, now })!;

      for (let i = 0; i < 25; i++) {
        const thief = stores.tasks.claim({
          runId, taskId: 'H', workerId: `thief-${i}`, leaseMs: 60_000, now: now + i
        });
        expect(thief).toBeNull();
      }

      const task = stores.tasks.get({ runId, taskId: 'H' })!;
      expect(task.ownerId).toBe('healthy');
      expect(task.fence).toBe(owner.fence);
      expect(task.attempt).toBe(1);
    });

    it('an EXPIRED lease is reclaimable, and only then', () => {
      const runId = makeRun(['E']);
      const now = Date.now();
      stores.tasks.claim({ runId, taskId: 'E', workerId: 'dead', leaseMs: 1_000, now })!;

      expect(stores.tasks.claim({ runId, taskId: 'E', workerId: 'next', leaseMs: 1_000, now: now + 999 })).toBeNull();
      const reclaimed = stores.tasks.claim({ runId, taskId: 'E', workerId: 'next', leaseMs: 1_000, now: now + 1_001 });
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.fence).toBe(2);
      expect(stores.tasks.get({ runId, taskId: 'E' })!.ownerId).toBe('next');
    });

    it('findReclaimable reports only expired leases', () => {
      const runId = makeRun(['R1', 'R2']);
      const now = Date.now();
      stores.tasks.claim({ runId, taskId: 'R1', workerId: 'a', leaseMs: 100, now });
      stores.tasks.claim({ runId, taskId: 'R2', workerId: 'b', leaseMs: 60_000, now });

      const reclaimable = stores.tasks.findReclaimable(runId, now + 500);
      expect(reclaimable.map((t) => t.id)).toEqual(['R1']);
    });
  });

  // ---- B17: lease renewal -------------------------------------------------
  describe('lease renewal (B17)', () => {
    it('the owner can renew, which pushes the expiry out', () => {
      const runId = makeRun(['RN']);
      const now = Date.now();
      const ticket = stores.tasks.claim({ runId, taskId: 'RN', workerId: 'owner', leaseMs: 1_000, now })!;
      const renewed = stores.tasks.renewLease(ticket, 1_000, now + 500);

      expect(renewed).not.toBeNull();
      expect(renewed!.leaseExpiresAt).toBe(now + 1_500);
      // Would have been reclaimable at now+1001 without the renewal.
      expect(stores.tasks.claim({ runId, taskId: 'RN', workerId: 'thief', leaseMs: 1_000, now: now + 1_200 })).toBeNull();
    });

    it('renewal from the wrong owner is rejected', () => {
      const runId = makeRun(['RW']);
      const now = Date.now();
      const ticket = stores.tasks.claim({ runId, taskId: 'RW', workerId: 'owner', leaseMs: 1_000, now })!;
      const forged: ClaimTicket = { ...ticket, workerId: 'impostor' };
      expect(stores.tasks.renewLease(forged, 1_000, now + 100)).toBeNull();
    });

    it('renewal with a stale fence is rejected', () => {
      const runId = makeRun(['RF']);
      const now = Date.now();
      const old = stores.tasks.claim({ runId, taskId: 'RF', workerId: 'w1', leaseMs: 100, now })!;
      stores.tasks.claim({ runId, taskId: 'RF', workerId: 'w2', leaseMs: 60_000, now: now + 500 })!;
      expect(stores.tasks.renewLease(old, 60_000, now + 600)).toBeNull();
    });

    it('renewal stops working once the task reaches a terminal state', () => {
      const runId = makeRun(['RT']);
      const now = Date.now();
      const ticket = stores.tasks.claim({ runId, taskId: 'RT', workerId: 'owner', leaseMs: 60_000, now })!;
      expect(stores.tasks.complete(ticket, { state: 'SUCCEEDED', output: 1, completedAt: new Date().toISOString() })).toBe(true);
      expect(stores.tasks.renewLease(ticket, 60_000, now + 10)).toBeNull();
    });
  });

  // ---- B6 + B7: fencing and ownership-checked writes ----------------------
  describe('fencing: a superseded worker cannot write (B6, B7)', () => {
    it('full scenario — old fence rejected, new fence canonical', () => {
      const runId = makeRun(['F']);
      const now = Date.now();
      const trace: Record<string, unknown>[] = [];
      const snapshot = (label: string) => {
        const t = stores.tasks.get({ runId, taskId: 'F' })!;
        trace.push({ step: label, state: t.state, owner: t.ownerId, fence: t.fence, attempt: t.attempt, output: t.output });
      };

      // 1. Worker A claims with fence N.
      const a = stores.tasks.claim({ runId, taskId: 'F', workerId: 'worker-A', leaseMs: 1_000, now })!;
      snapshot('1: A claimed');
      expect(a.fence).toBe(1);

      // 2-3. A's lease expires; B reclaims with fence N+1.
      const b = stores.tasks.claim({ runId, taskId: 'F', workerId: 'worker-B', leaseMs: 60_000, now: now + 1_500 })!;
      snapshot('3: B reclaimed');
      expect(b.fence).toBe(2);

      // 4-6. A returns late and tries to persist success on the stale fence.
      const staleSuccess = stores.tasks.complete(a, {
        state: 'SUCCEEDED', output: { from: 'worker-A (stale)' }, completedAt: new Date().toISOString()
      });
      snapshot('6: A stale success attempted');
      expect(staleSuccess).toBe(false);

      // A stale FAILURE must be rejected too.
      const staleFailure = stores.tasks.complete(a, {
        state: 'FAILED', error: 'stale failure from A', completedAt: new Date().toISOString()
      });
      expect(staleFailure).toBe(false);

      // A stale heartbeat must not revive lost ownership.
      expect(stores.tasks.renewLease(a, 60_000, now + 1_600)).toBeNull();
      snapshot('6b: A stale renewal attempted');

      // 7-8. B completes on the current fence; its output is canonical.
      expect(stores.tasks.complete(b, {
        state: 'SUCCEEDED', output: { from: 'worker-B' }, completedAt: new Date().toISOString()
      })).toBe(true);
      snapshot('8: B completed');

      const final = stores.tasks.get({ runId, taskId: 'F' })!;
      expect(final.state).toBe('SUCCEEDED');
      expect(final.output).toEqual({ from: 'worker-B' });
      expect(final.error).toBeUndefined();
      expect(final.ownerId).toBeUndefined();
      expect(final.fence).toBe(2);

      // Persisted row after each step, for the report.
      expect(trace).toHaveLength(5);
      expect(trace[0]).toMatchObject({ owner: 'worker-A', fence: 1, attempt: 1 });
      expect(trace[1]).toMatchObject({ owner: 'worker-B', fence: 2, attempt: 2 });
      expect(trace[2]).toMatchObject({ owner: 'worker-B', fence: 2, state: 'RUNNING' });
    });

    it('a completion from a never-valid ticket is rejected', () => {
      const runId = makeRun(['X']);
      const forged: ClaimTicket = {
        runId, taskId: 'X', workerId: 'nobody', fence: 99, attempt: 99,
        retriesAttempted: 0, leaseExpiresAt: Date.now() + 60_000
      };
      expect(stores.tasks.complete(forged, { state: 'SUCCEEDED', output: 'forged', completedAt: new Date().toISOString() })).toBe(false);
      expect(stores.tasks.get({ runId, taskId: 'X' })!.state).toBe('READY');
    });
  });

  // ---- B10: global concurrency ceiling enforced inside the claim ----------
  describe('global concurrency ceiling (B10)', () => {
    it('claims beyond the ceiling are refused, even from different workers', () => {
      const runId = makeRun(['C1', 'C2', 'C3', 'C4', 'C5']);
      const now = Date.now();
      const won: string[] = [];
      for (const id of ['C1', 'C2', 'C3', 'C4', 'C5']) {
        const t = stores.tasks.claim({
          runId, taskId: id, workerId: `w-${id}`, leaseMs: 60_000, now, maxConcurrent: 2
        });
        if (t) won.push(id);
      }
      expect(won).toHaveLength(2);
      expect(stores.tasks.countLiveClaims(runId, now)).toBe(2);
    });

    it('a slot freed by completion becomes claimable again', () => {
      const runId = makeRun(['D1', 'D2', 'D3']);
      const now = Date.now();
      const t1 = stores.tasks.claim({ runId, taskId: 'D1', workerId: 'w1', leaseMs: 60_000, now, maxConcurrent: 1 })!;
      expect(stores.tasks.claim({ runId, taskId: 'D2', workerId: 'w2', leaseMs: 60_000, now, maxConcurrent: 1 })).toBeNull();

      stores.tasks.complete(t1, { state: 'SUCCEEDED', output: 1, completedAt: new Date().toISOString() });
      expect(stores.tasks.claim({ runId, taskId: 'D2', workerId: 'w2', leaseMs: 60_000, now, maxConcurrent: 1 })).not.toBeNull();
    });
  });

  // ---- B16: claim race across REAL processes ------------------------------
  describe('claim race across real OS processes (B16)', () => {
    it('20 processes race for one task, repeatedly: exactly one winner each time', () => {
      const ITERATIONS = 5;
      const RACERS = 20;
      const results = { iterations: 0, attempts: 0, winners: 0, duplicateWinners: 0 };

      for (let i = 0; i < ITERATIONS; i++) {
        const runId = makeRun([`RACE${i}`]);
        // Give every process the same wall-clock start instant.
        const startAt = Date.now() + 700;

        const outputs = Array.from({ length: RACERS }, () =>
          execFileSync(process.execPath, [CLAIM_WORKER], {
            env: {
              ...process.env,
              DATABASE_URL: dbPath,
              RUN_ID: runId,
              TASK_ID: `RACE${i}`,
              START_AT: String(startAt),
              LEASE_MS: '60000',
              LOG_LEVEL: 'silent'
            },
            encoding: 'utf-8',
            cwd: path.join(__dirname, '..')
          })
        );

        const parsed = outputs.map((o) => JSON.parse(o));
        const winners = parsed.filter((p) => p.won);

        results.iterations++;
        results.attempts += RACERS;
        results.winners += winners.length;
        if (winners.length > 1) results.duplicateWinners += winners.length - 1;

        expect(winners).toHaveLength(1);
        expect(parsed.filter((p) => !p.won)).toHaveLength(RACERS - 1);
        // The single winner holds fence 1 on a first claim.
        expect(winners[0].fence).toBe(1);
        expect(winners[0].attempt).toBe(1);
        // And the row agrees.
        const task = stores.tasks.get({ runId, taskId: `RACE${i}` })!;
        expect(task.ownerId).toBe(winners[0].workerId);
        expect(new Set(parsed.map((p) => p.pid)).size).toBe(RACERS);
      }

      expect(results.duplicateWinners).toBe(0);
      expect(results.winners).toBe(ITERATIONS);
      expect(results.attempts).toBe(ITERATIONS * RACERS);
    }, 180_000);
  });
});
