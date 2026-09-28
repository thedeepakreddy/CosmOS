import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/api/server';
import { Supervisor } from '../src/engine/Supervisor';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import { ConfigSchema } from '../src/config';
import { AgentOSClient } from '../src/sdk/client';
import {
  EVENT_TYPES, validateEventStream, isDeclaredEventType, EventPayloadSchemas
} from '../src/domain/events';
import { Metrics } from '../src/observability/metrics';
import type { Stores } from '../src/persistence/contracts';
import { AgentExecutor, Task } from '../src/index';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase F. The audit's question was:
 *   "Can an engineer understand why a run failed using production telemetry alone?"
 * The answer was no, and observability scored 2/10.
 */
describe('Event vocabulary and stream integrity (Phase F)', () => {
  const dbPath = testDbPath('observability-events');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'ob', version: '1', name: 'ob', description: '', role: '', capabilities: [] });
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  function makeRun(ids: string[], extra: Partial<Task> = {}, deps: Array<{ taskId: string; dependsOn: string }> = []): string {
    const runId = `OB${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'observability', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: ids.map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'ob',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0, ...extra
        })),
        dependencies: deps
      }
    });
    return runId;
  }

  const settle = async (runId: string, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const run = stores.runs.getMeta(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;
      if (Date.now() > deadline) return run;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('every emitted event is declared and schema-valid, with no sequence gaps', async () => {
    const runId = makeRun(['A', 'B'], {}, [{ taskId: 'B', dependsOn: 'A' }]);
    const sup = new Supervisor({ async execute() { return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 60_000 });
    sup.recordRunCreated(runId, 'observability', 2, 'corr-1');
    await sup.startRun(runId, 'corr-2');
    await settle(runId);
    sup.close();

    const events = stores.events.listByRun(runId);
    expect(events.length).toBeGreaterThan(5);

    // Envelope shape, declared type, payload schema, and sequence integrity.
    expect(validateEventStream(events)).toEqual([]);

    // Sequence starts at 1 and is strictly consecutive.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });

  it('run.created is emitted (v0.1 advertised it and never produced it)', async () => {
    const runId = makeRun(['X']);
    const sup = new Supervisor({ async execute() { return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 60_000 });
    sup.recordRunCreated(runId, 'observability', 1);
    sup.close();

    const first = stores.events.listByRun(runId)[0];
    expect(first.type).toBe('run.created');
    expect(first.seq).toBe(1);
    expect(EventPayloadSchemas['run.created'].safeParse(first.payload).success).toBe(true);
  });

  it('run.paused now means PAUSED, not "pausing"', async () => {
    const runId = makeRun(['P1', 'P2', 'P3']);
    const sup = new Supervisor({
      async execute() { await new Promise((r) => setTimeout(r, 80)); return { status: 'SUCCEEDED', output: 1 }; }
    }, { stores, leaseMs: 60_000 });

    await sup.startRun(runId);
    await new Promise((r) => setTimeout(r, 20));
    await sup.pauseRun(runId);

    const atPause = stores.events.listByRun(runId).map((e) => e.type);
    // Entering PAUSING announces itself honestly...
    expect(atPause).toContain('run.pausing');
    // ...and run.paused has NOT fired yet, because tasks are still running.
    expect(atPause).not.toContain('run.paused');

    await new Promise((r) => setTimeout(r, 400));
    const settled = stores.events.listByRun(runId).map((e) => e.type);
    expect(settled).toContain('run.paused');
    expect(stores.runs.getMeta(runId)!.state).toBe('PAUSED');
    sup.close();
  });

  it('task.skipped is emitted, so a reader can see WHY a task never ran', async () => {
    const runId = makeRun(['S1', 'S2'], {}, [{ taskId: 'S2', dependsOn: 'S1' }]);
    const sup = new Supervisor({
      async execute(_a, t) {
        return t.id === 'S1'
          ? { status: 'FAILED', error: 'upstream broke' }
          : { status: 'SUCCEEDED', output: 1 };
      }
    }, { stores, leaseMs: 60_000 });
    await sup.startRun(runId);
    await settle(runId);
    sup.close();

    const types = stores.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('task.failed');
    expect(types).toContain('task.skipped');
    expect(validateEventStream(stores.events.listByRun(runId))).toEqual([]);
  });

  it('every declared event type has a payload schema, and vice versa', () => {
    for (const t of EVENT_TYPES) {
      expect(isDeclaredEventType(t)).toBe(true);
      expect(EventPayloadSchemas[t]).toBeDefined();
    }
    expect(isDeclaredEventType('task.invented')).toBe(false);
  });

  it('the validator actually detects gaps, duplicates and undeclared types', () => {
    const base = { id: 'e', runId: 'r', timestamp: new Date().toISOString(), payload: { runId: 'r' } };
    // A gap.
    expect(validateEventStream([
      { ...base, seq: 1, type: 'run.started' }, { ...base, seq: 3, type: 'run.completed' }
    ]).some((i) => i.problem.includes('sequence break'))).toBe(true);
    // A duplicate.
    expect(validateEventStream([
      { ...base, seq: 1, type: 'run.started' }, { ...base, seq: 1, type: 'run.completed' }
    ]).some((i) => i.problem.includes('sequence break'))).toBe(true);
    // An undeclared type.
    expect(validateEventStream([
      { ...base, seq: 1, type: 'run.invented' }
    ]).some((i) => i.problem === 'undeclared event type')).toBe(true);
    // A malformed payload.
    expect(validateEventStream([
      { ...base, seq: 1, type: 'task.started', payload: { runId: 'r' } }
    ]).some((i) => i.problem.includes('invalid payload'))).toBe(true);
  });

  it('a duplicate sequence number is impossible at the database level', () => {
    const runId = makeRun(['D']);
    stores.events.append({ runId, type: 'run.started', payload: { runId } });
    const all = stores.events.listByRun(runId);
    expect(new Set(all.map((e) => e.seq)).size).toBe(all.length);
  });
});

describe('Correlation and attempt history (Phase F)', () => {
  const dbPath = testDbPath('observability-correlation');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'co', version: '1', name: 'co', description: '', role: '', capabilities: [] });
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });

  it('every event caused by one operation shares its correlation id', async () => {
    const runId = 'CORR1';
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'corr', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: ['C1', 'C2'].map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'co',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    });

    const sup = new Supervisor({ async execute() { return { status: 'SUCCEEDED', output: 1 }; } },
      { stores, leaseMs: 60_000 });
    await sup.startRun(runId, 'request-abc');
    for (let i = 0; i < 100 && stores.runs.getMeta(runId)!.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    sup.close();

    const events = stores.events.listByRun(runId);
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) {
      expect(e.correlationId, `${e.type} has no correlation id`).toBe('request-abc');
    }
  });

  it('records one durable row per real execution, with measured durations', async () => {
    const runId = 'ATT1';
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'attempts', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: [{
          id: 'R', runId, name: 'R', description: '', agentDefinitionId: 'co',
          state: 'PENDING', createdAt: now, retriesAllowed: 2, retriesAttempted: 0
        }],
        dependencies: []
      }
    });

    let n = 0;
    const executor: AgentExecutor = {
      async execute() {
        n++;
        await new Promise((r) => setTimeout(r, 20));
        return n < 3 ? { status: 'FAILED', error: `transient ${n}` } : { status: 'SUCCEEDED', output: n };
      }
    };
    const sup = new Supervisor(executor, { stores, workerId: 'w-attempts', leaseMs: 60_000 });
    await sup.startRun(runId);
    for (let i = 0; i < 300 && stores.runs.getMeta(runId)!.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    sup.close();

    const attempts = stores.events.listAttempts(runId, 'R');
    // v0.1 kept NO history: a retry overwrote the task row and earlier attempts
    // vanished, with startedAt and completedAt measured as identical.
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(attempts.map((a) => a.outcome)).toEqual(['FAILED', 'FAILED', 'SUCCEEDED']);
    expect(attempts[0].error).toBe('transient 1');
    expect(attempts[1].error).toBe('transient 2');
    for (const a of attempts) {
      expect(a.workerId).toBe('w-attempts');
      expect(a.durationMs).toBeGreaterThanOrEqual(15);
      expect(a.endedAt).toBeTruthy();
      expect(a.fence).toBeGreaterThan(0);
    }
    // Each attempt started after the previous one ended: real, ordered history.
    expect(new Date(attempts[1].startedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(attempts[0].endedAt!).getTime());
  });

  it('SUCCESS CRITERION: a failed run is explainable from telemetry alone', async () => {
    const runId = 'EXPLAIN1';
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'explain me', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: ['fetch', 'parse', 'report'].map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'co',
          state: 'PENDING', createdAt: now, retriesAllowed: 1, retriesAttempted: 0
        })),
        dependencies: [
          { taskId: 'parse', dependsOn: 'fetch' },
          { taskId: 'report', dependsOn: 'parse' }
        ]
      }
    });

    const sup = new Supervisor({
      async execute(_a, t) {
        if (t.id === 'parse') return { status: 'FAILED', error: 'malformed payload at byte 42' };
        return { status: 'SUCCEEDED', output: t.id };
      }
    }, { stores, workerId: 'w-explain', leaseMs: 60_000 });

    sup.recordRunCreated(runId, 'explain me', 3, 'req-explain');
    await sup.startRun(runId, 'req-explain');
    for (let i = 0; i < 400 && stores.runs.getMeta(runId)!.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    sup.close();

    // --- reconstruct the story using ONLY events and attempts ---------------
    const events = stores.events.listByRun(runId);
    const attempts = stores.events.listAttempts(runId);
    expect(validateEventStream(events)).toEqual([]);

    const typesOf = (taskId: string) =>
      events.filter((e) => e.taskId === taskId).map((e) => e.type);

    // 1. The run was created, and how big it was.
    const created = events.find((e) => e.type === 'run.created')!;
    expect((created.payload as { goal: string; taskCount: number }).taskCount).toBe(3);

    // 2. It failed, and the run-level reason is stated.
    const failed = events.find((e) => e.type === 'run.failed')!;
    expect((failed.payload as { error: string }).error).toBe('TASK_FAILED');
    expect(typeof (failed.payload as { durationMs: number }).durationMs).toBe('number');

    // 3. WHICH task failed, with the executor's actual message.
    const taskFailed = events.filter((e) => e.type === 'task.failed');
    expect(taskFailed.map((e) => e.taskId)).toContain('parse');
    expect((taskFailed[taskFailed.length - 1].payload as { error: string }).error)
      .toBe('malformed payload at byte 42');

    // 4. That it was RETRIED first, and how long the backoff was.
    const retry = events.find((e) => e.type === 'task.retry.scheduled')!;
    expect(retry.taskId).toBe('parse');
    expect((retry.payload as { backoffMs: number }).backoffMs).toBeGreaterThan(0);
    expect(stores.events.listAttempts(runId, 'parse')).toHaveLength(2);   // 1 + 1 retry

    // 5. What succeeded before it.
    expect(typesOf('fetch')).toContain('task.succeeded');

    // 6. Why the downstream task never ran.
    expect(typesOf('report')).toContain('task.skipped');
    expect(typesOf('report')).not.toContain('task.started');

    // 7. Which worker did the work, and how long each attempt took.
    for (const a of attempts) {
      expect(a.workerId).toBe('w-explain');
      expect(typeof a.durationMs).toBe('number');
    }

    // 8. Every event is attributable to some operation -- none is orphaned.
    for (const e of events) {
      expect(e.correlationId, `${e.type} (seq ${e.seq}) has no correlation id`).toBeTruthy();
    }
    // The events caused by the originating request carry ITS id. A retry fired
    // later by a backoff timer is a separate causal origin and correctly gets
    // its own -- correlation ties events to the operation that caused them, not
    // to the run.
    expect(events.filter((e) => e.correlationId === 'req-explain').length)
      .toBeGreaterThan(3);
    expect(events.find((e) => e.type === 'run.created')!.correlationId).toBe('req-explain');
    expect(events.find((e) => e.type === 'run.started')!.correlationId).toBe('req-explain');
  });
});

describe('Metrics (Phase F)', () => {
  it('counts, gauges and summarises', () => {
    const m = new Metrics();
    m.increment('reqs', { route: '/a' });
    m.increment('reqs', { route: '/a' });
    m.increment('reqs', { route: '/b' });
    m.setGauge('inflight', 3);
    for (const v of [10, 20, 30, 40]) m.observe('dur', v);

    expect(m.getCounter('reqs', { route: '/a' })).toBe(2);
    expect(m.getCounter('reqs', { route: '/b' })).toBe(1);
    expect(m.percentile('dur', 50)).toBe(30);

    const text = m.render();
    expect(text).toContain('# TYPE reqs counter');
    expect(text).toContain('reqs{route="/a"} 2');
    expect(text).toContain('# TYPE inflight gauge');
    expect(text).toContain('dur_count 4');
    expect(text).toContain('dur_sum 100');
    expect(text).toContain('quantile="0.95"');
  });

  it('bounds histogram memory', () => {
    const m = new Metrics();
    for (let i = 0; i < 5_000; i++) m.observe('x', i);
    expect(m.render()).toContain('x_count 1000');
  });

  it('escapes label values so the exposition cannot be broken', () => {
    const m = new Metrics();
    m.increment('c', { label: 'a"b\\c' });
    expect(m.render()).toContain('a\\"b\\\\c');
  });
});

describe('Observability endpoints (Phase F)', () => {
  const dbPath = testDbPath('observability-http');
  let app: any;
  let base: string;
  let client: AgentOSClient;
  let runId: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: {
        async execute(_a, t) {
          return t.id === 'BAD'
            ? { status: 'FAILED', error: 'deliberate' }
            : { status: 'SUCCEEDED', output: t.id };
        }
      },
      config: ConfigSchema.parse({ rateLimitEnabled: false })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
    client = new AgentOSClient(base);

    await client.createAgent({ id: 'oe', version: '1', name: 'oe', description: '', role: '', capabilities: [] });
    const run = await client.createRun({
      goal: 'http observability',
      taskGraph: {
        tasks: ['OK', 'BAD'].map((id) => ({
          id, name: id, description: '', agentDefinitionId: 'oe', state: 'PENDING'
        })),
        dependencies: []
      }
    } as any);
    runId = run.id;
    await client.startRun(runId);
    for (let i = 0; i < 200 && (await client.getRun(runId)).state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  it('exposes the event stream over HTTP, schema-valid', async () => {
    const { events, lastSeq } = await client.getEvents(runId);
    expect(events.length).toBeGreaterThan(3);
    expect(validateEventStream(events)).toEqual([]);
    expect(lastSeq).toBe(events[events.length - 1].seq);
    expect(events[0].type).toBe('run.created');
  });

  it('supports tailing from a resume point with no gap and no replay', async () => {
    const all = await client.getEvents(runId);
    const mid = all.events[2].seq;
    const tail = await client.getEvents(runId, mid);
    expect(tail.events[0].seq).toBe(mid + 1);
    expect(tail.events.every((e) => e.seq > mid)).toBe(true);
    expect(tail.events.length).toBe(all.events.length - 3);
  });

  it('exposes per-attempt history over HTTP', async () => {
    const { attempts } = await client.getAttempts(runId);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const a of attempts) {
      expect(a.workerId).toBeTruthy();
      expect(typeof a.durationMs).toBe('number');
      expect(a.outcome).toBeTruthy();
    }
    const bad = await client.getAttempts(runId, 'BAD');
    expect(bad.attempts.every((a) => a.taskId === 'BAD')).toBe(true);
  });

  it('serves Prometheus metrics reflecting real activity', async () => {
    const text = await client.metrics();
    expect(text).toContain('# TYPE agentos_events_total counter');
    expect(text).toContain('agentos_task_attempts_total');
    expect(text).toContain('agentos_http_requests_total');
    // Route labels, not raw urls: cardinality stays bounded.
    expect(text).not.toContain(runId);
  });

  it('streams events over SSE and terminates on a terminal event', async () => {
    const res = await fetch(`${base}/v1/runs/${runId}/events/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: run.created');
    expect(body).toContain('event: run.failed');
    expect(body).toMatch(/^id: 1$/m);
  });

  it('events and attempts for an unknown run are 404, not an empty stream', async () => {
    expect((await fetch(`${base}/v1/runs/nope/events`)).status).toBe(404);
    expect((await fetch(`${base}/v1/runs/nope/attempts`)).status).toBe(404);
    expect((await fetch(`${base}/v1/runs/nope/events/stream`)).status).toBe(404);
  });
});
