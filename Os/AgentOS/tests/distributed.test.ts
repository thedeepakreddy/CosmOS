import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Supervisor } from '../src/engine/Supervisor';
import { startWorker } from '../src/worker';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import { ConfigSchema } from '../src/config';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase H: messaging, handoffs, shared rate limiting and the standalone worker.
 *
 * Multi-PROCESS ownership under chaos is proven in multiprocess.test.ts with
 * real OS processes; this file covers the Phase H surfaces built on top of it.
 */
describe('Messaging and handoffs (Phase H)', () => {
  const dbPath = testDbPath('distributed-messaging');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    for (const id of ['sender', 'receiver']) {
      stores.agents.save({
        id, version: '1.0.0', name: id, description: '', role: 'worker', capabilities: []
      });
    }
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  function makeRun(tasks: Array<{ id: string; agent: string }>, deps: Array<{ taskId: string; dependsOn: string }> = []): string {
    const runId = `MSG${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'messaging', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: tasks.map<Task>((t) => ({
          id: t.id, runId, name: t.id, description: '', agentDefinitionId: t.agent,
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: deps
      }
    });
    return runId;
  }

  const settle = async (runId: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const run = stores.runs.getMeta(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;
      if (Date.now() > deadline) return run;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('a HANDOFF carries context from one agent to the next', async () => {
    const runId = makeRun(
      [{ id: 'first', agent: 'sender' }, { id: 'second', agent: 'receiver' }],
      [{ taskId: 'second', dependsOn: 'first' }]
    );
    const received: unknown[] = [];

    const executor: AgentExecutor = {
      async execute(_agent, task, ctx) {
        if (task.id === 'first') {
          ctx.send({ type: 'HANDOFF', toTaskId: 'second', payload: { findings: 'three papers', by: task.id } });
          return { status: 'SUCCEEDED', output: 'handed off' };
        }
        received.push(...ctx.inbox.map((m) => ({ type: m.type, payload: m.payload })));
        return { status: 'SUCCEEDED', output: 'received' };
      }
    };

    const sup = new Supervisor(executor, { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    expect((await settle(runId)).state).toBe('COMPLETED');
    sup.close();

    // v0.1 had a HANDOFF message type with no mechanism, and a `messages` table
    // with zero code references.
    expect(received).toEqual([{ type: 'HANDOFF', payload: { findings: 'three papers', by: 'first' } }]);

    const messages = stores.messages.listByRun(runId);
    expect(messages).toHaveLength(1);
    expect(messages[0].seq).toBe(1);
    expect(messages[0].fromTaskId).toBe('first');
    expect(messages[0].fromInstanceId).toBeTruthy();   // attributable to an instance
    expect(messages[0].deliveredAt).toBeTruthy();
  });

  it('messages are addressable by task, by agent definition, or broadcast', () => {
    const runId = makeRun([{ id: 'a', agent: 'sender' }, { id: 'b', agent: 'receiver' }]);
    stores.messages.send({ runId, type: 'STATUS', toTaskId: 'a', payload: 'for-a' });
    stores.messages.send({ runId, type: 'STATUS', toAgentDefinitionId: 'receiver', payload: 'for-receivers' });
    stores.messages.send({ runId, type: 'STATUS', payload: 'broadcast' });

    expect(stores.messages.inboxFor(runId, 'a', 'sender').map((m) => m.payload))
      .toEqual(['for-a', 'broadcast']);
    expect(stores.messages.inboxFor(runId, 'b', 'receiver').map((m) => m.payload))
      .toEqual(['for-receivers', 'broadcast']);
  });

  it('messages never cross a run boundary', () => {
    const runA = makeRun([{ id: 'shared', agent: 'sender' }]);
    const runB = makeRun([{ id: 'shared', agent: 'sender' }]);
    stores.messages.send({ runId: runA, type: 'STATUS', toTaskId: 'shared', payload: 'A only' });

    // Same task id in both runs -- Phase B identity holds here too.
    expect(stores.messages.inboxFor(runA, 'shared', 'sender').map((m) => m.payload)).toEqual(['A only']);
    expect(stores.messages.inboxFor(runB, 'shared', 'sender')).toEqual([]);
  });

  it('sequence numbers are monotonic and delivery is marked once', () => {
    const runId = makeRun([{ id: 'x', agent: 'sender' }]);
    const sent = [1, 2, 3].map((n) =>
      stores.messages.send({ runId, type: 'STATUS', toTaskId: 'x', payload: n })
    );
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3]);

    const ids = sent.map((m) => m.id);
    expect(stores.messages.markDelivered(runId, ids)).toBe(3);
    // Idempotent: a reclaimed attempt re-reading its inbox marks nothing new.
    expect(stores.messages.markDelivered(runId, ids)).toBe(0);
  });
});

describe('Shared rate limiting (Phase H)', () => {
  const dbPath = testDbPath('distributed-ratelimit');
  let stores: Stores;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });

  it('the ceiling is shared, not per-process', () => {
    const now = Date.now();
    // Phase E's limiter was per-process, so N workers meant N x limit. These
    // calls stand in for N separate workers hitting one shared window.
    const decisions = Array.from({ length: 10 }, () =>
      stores.rateLimits.check('client-1', 3, 60_000, now)
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    expect(decisions[decisions.length - 1].remaining).toBe(0);
  });

  it('separate keys have separate budgets', () => {
    const now = Date.now();
    expect(stores.rateLimits.check('k-a', 1, 60_000, now).allowed).toBe(true);
    expect(stores.rateLimits.check('k-b', 1, 60_000, now).allowed).toBe(true);
    expect(stores.rateLimits.check('k-a', 1, 60_000, now).allowed).toBe(false);
  });

  it('the window rolls over, and expired rows are prunable', () => {
    const t0 = Date.now();
    expect(stores.rateLimits.check('roll', 1, 1_000, t0).allowed).toBe(true);
    expect(stores.rateLimits.check('roll', 1, 1_000, t0 + 500).allowed).toBe(false);
    expect(stores.rateLimits.check('roll', 1, 1_000, t0 + 1_500).allowed).toBe(true);
    expect(stores.rateLimits.prune(t0 + 10_000)).toBeGreaterThan(0);
  });
});

describe('Standalone worker (Phase H)', () => {
  const dbPath = testDbPath('distributed-worker');
  let stores: Stores;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({
      id: 'wk', version: '1.0.0', name: 'wk', description: '', role: 'worker', capabilities: []
    });
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });

  it('claims and drains work with no HTTP server involved', async () => {
    const runId = `WK_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'worker drain', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: Array.from({ length: 12 }, (_, i) => ({
          id: `T${i}`, runId, name: 't', description: '', agentDefinitionId: 'wk',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    });

    const executed: string[] = [];
    const handle = startWorker({
      executor: { async execute(_a, t) { executed.push(t.id); return { status: 'SUCCEEDED', output: t.id }; } },
      config: ConfigSchema.parse({}),
      stores,
      pollIntervalMs: 20,
      maxRuntimeMs: 15_000,
      workerId: 'standalone-1'
    });

    const deadline = Date.now() + 15_000;
    while (stores.runs.getMeta(runId)!.state !== 'COMPLETED' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    handle.stop();
    await handle.done;

    expect(stores.runs.getMeta(runId)!.state).toBe('COMPLETED');
    expect(executed).toHaveLength(12);
    expect(new Set(executed).size).toBe(12);   // each exactly once
    // Every instance records the worker that ran it.
    expect(stores.instances.listByRun(runId).every((i) => i.workerId === 'standalone-1')).toBe(true);
  }, 30_000);

  it('several in-process workers contend safely on one database', async () => {
    const runId = `WKC_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'worker contention', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: Array.from({ length: 30 }, (_, i) => ({
          id: `C${i}`, runId, name: 't', description: '', agentDefinitionId: 'wk',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    });

    const executions: string[] = [];
    const inFlight = new Set<string>();
    let overlaps = 0;
    const executor: AgentExecutor = {
      async execute(_a, t) {
        if (inFlight.has(t.id)) overlaps++;
        inFlight.add(t.id);
        executions.push(t.id);
        await new Promise((r) => setTimeout(r, 10));
        inFlight.delete(t.id);
        return { status: 'SUCCEEDED', output: t.id };
      }
    };

    const handles = ['w1', 'w2', 'w3'].map((id) =>
      startWorker({
        executor, config: ConfigSchema.parse({}), stores,
        pollIntervalMs: 15, maxRuntimeMs: 20_000, workerId: id
      })
    );

    const deadline = Date.now() + 20_000;
    while (stores.runs.getMeta(runId)!.state !== 'COMPLETED' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const h of handles) h.stop();
    await Promise.all(handles.map((h) => h.done));

    expect(stores.runs.getMeta(runId)!.state).toBe('COMPLETED');
    expect(overlaps).toBe(0);
    expect(executions).toHaveLength(30);
    expect(new Set(executions).size).toBe(30);
    expect(stores.tasks.listByRun(runId).every((t) => t.attempt === 1)).toBe(true);
  }, 40_000);
});
