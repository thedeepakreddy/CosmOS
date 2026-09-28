import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import { getDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * A1: an invalid task graph must be rejected BEFORE anything is persisted.
 *
 * The audit showed duplicate ids silently collapsing into one row while the run
 * still reported COMPLETED, and a dependency on a nonexistent task surfacing as
 * a raw SQLite foreign-key error inside a 500.
 */
describe('Run creation validation (A1)', () => {
  let app: any;
  let base: string;
  const dbPath = testDbPath('validation');
  process.env.DATABASE_URL = dbPath;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    description: '',
    agentDefinitionId: 'validator-agent',
    state: 'PENDING',
    ...extra
  });

  const runCount = () =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
  const taskCount = () =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;

  beforeAll(async () => {
    removeDb(dbPath);
    app = await buildServer(new TestAgentExecutor());
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
    await post('/v1/agents', {
      id: 'validator-agent',
      version: '1',
      name: 'V',
      description: '',
      role: '',
      capabilities: []
    });
  });

  afterAll(async () => {
    await app.close();
    removeDb(dbPath);
  });

  it('rejects duplicate task ids with 400 and persists nothing', async () => {
    const runsBefore = runCount();
    const tasksBefore = taskCount();

    const res = await post('/v1/runs', {
      goal: 'duplicate ids',
      taskGraph: {
        tasks: [task('DUP', { name: 'first' }), task('DUP', { name: 'second' }), task('OK')],
        dependencies: []
      }
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('DUPLICATE_TASK_ID');

    // The critical assertion: the rejection happened before persistence.
    expect(runCount()).toBe(runsBefore);
    expect(taskCount()).toBe(tasksBefore);
  });

  it('rejects duplicate ids carrying different inputs', async () => {
    const tasksBefore = taskCount();
    const res = await post('/v1/runs', {
      goal: 'duplicate ids, different payloads',
      taskGraph: {
        tasks: [
          task('X', { input: { owner: 'A' } }),
          task('X', { input: { owner: 'B' } })
        ],
        dependencies: []
      }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('DUPLICATE_TASK_ID');
    expect(body.error.message).toBe('DUPLICATE_TASK_ID: X');
    expect(taskCount()).toBe(tasksBefore);
  });

  it('rejects a cycle at creation time rather than at start', async () => {
    const runsBefore = runCount();
    const res = await post('/v1/runs', {
      goal: 'cycle',
      taskGraph: {
        tasks: [task('C1'), task('C2')],
        dependencies: [
          { taskId: 'C1', dependsOn: 'C2' },
          { taskId: 'C2', dependsOn: 'C1' }
        ]
      }
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('CYCLE_DETECTED');
    expect(runCount()).toBe(runsBefore);
  });

  it('returns 400 (not a 500 leaking SQLITE_CONSTRAINT) for an unknown dependency', async () => {
    const res = await post('/v1/runs', {
      goal: 'ghost dependency',
      taskGraph: {
        tasks: [task('G1')],
        dependencies: [{ taskId: 'G1', dependsOn: 'NOT_A_REAL_TASK' }]
      }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('UNKNOWN_DEPENDS_ON');
    expect(body.error.message).toBe('UNKNOWN_DEPENDS_ON: NOT_A_REAL_TASK');
    // Regression guard: the persistence engine must not be disclosed.
    expect(JSON.stringify(body)).not.toContain('SQLITE');
    expect(JSON.stringify(body)).not.toContain('FOREIGN KEY');
  });

  it('rejects duplicates at the persistence boundary, not only at the HTTP layer', async () => {
    // A programmatic consumer can build a run and hand it straight to the
    // repository, bypassing the route. The guard lives in RunRepository.save so
    // that no entry point can persist a graph with duplicate ids.
    const now = new Date().toISOString();
    const tasksBefore = taskCount();
    const runsBefore = runCount();

    expect(() =>
      createSqliteStores().runs.save({
        id: 'DIRECT_DUP',
        goal: 'direct',
        state: 'CREATED',
        createdAt: now,
        taskGraph: {
          tasks: [
            { id: 'D1', runId: 'DIRECT_DUP', name: 'first', description: '', agentDefinitionId: 'validator-agent', state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0 },
            { id: 'D1', runId: 'DIRECT_DUP', name: 'second', description: '', agentDefinitionId: 'validator-agent', state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0 }
          ],
          dependencies: []
        }
      })
    ).toThrow('DUPLICATE_TASK_ID: D1');

    // Nothing at all was written -- not the run row, not the surviving task.
    expect(taskCount()).toBe(tasksBefore);
    expect(runCount()).toBe(runsBefore);
    expect(createSqliteStores().runs.get('DIRECT_DUP')).toBeNull();
  });

  it('accepts a unique valid graph and persists it', async () => {
    const res = await post('/v1/runs', {
      goal: 'valid',
      taskGraph: {
        tasks: [task('V1'), task('V2')],
        dependencies: [{ taskId: 'V2', dependsOn: 'V1' }]
      }
    });
    expect(res.status).toBe(200);
    const run = await res.json();
    expect(run.id).toBeTruthy();
    expect(run.state).toBe('CREATED');

    const tasksRes = await fetch(`${base}/v1/runs/${run.id}/tasks`);
    expect((await tasksRes.json()).tasks).toHaveLength(2);
  });
});
