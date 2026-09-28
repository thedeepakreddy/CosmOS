import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import { runMigrations } from '../src/db/migrations';
import { closeDb, getDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * B1 + B14: run-scoped task identity.
 *
 * The audit's most damaging finding: with a GLOBAL `tasks.id` primary key, two
 * runs both using the caller id "T1" collided. The second run's task was
 * absorbed into the first (the upsert never updated run_id), the first run's
 * input was overwritten, and the second run reported COMPLETED having executed
 * nothing at all.
 */
describe('Run-scoped task identity (B1, B14)', () => {
  const dbPath = testDbPath('identity');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let app: any;
  let base: string;

  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, description: '', agentDefinitionId: 'idw', state: 'PENDING', ...extra
  });

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
    app = await buildServer(new TestAgentExecutor());
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
    await post('/v1/agents', {
      id: 'idw', version: '1', name: 'W', description: '', role: '', capabilities: []
    });
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    removeDb(dbPath);
  });

  it('the tasks table is keyed by (run_id, task_id), not by task_id alone', () => {
    const info = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string };
    expect(info.sql).toContain('PRIMARY KEY (run_id, task_id)');
    expect(info.sql).not.toMatch(/task_id\s+TEXT\s+PRIMARY KEY/);
  });

  it('three runs may all use the ids A, B, C without colliding', async () => {
    const created: string[] = [];
    for (const goal of ['RUN_A', 'RUN_B', 'RUN_C']) {
      const res = await post('/v1/runs', {
        goal,
        taskGraph: {
          tasks: [
            task('A', { input: { owner: goal } }),
            task('B', { input: { owner: goal } }),
            task('C', { input: { owner: goal } })
          ],
          dependencies: [{ taskId: 'B', dependsOn: 'A' }, { taskId: 'C', dependsOn: 'B' }]
        }
      });
      expect(res.status).toBe(200);
      created.push((await res.json()).id);
    }

    // Every run kept all three of its own tasks; nothing was absorbed.
    for (let i = 0; i < created.length; i++) {
      const tasks = stores.tasks.listByRun(created[i]);
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.id).sort()).toEqual(['A', 'B', 'C']);
      // And each carries ITS OWN input, not a later run's.
      const goal = ['RUN_A', 'RUN_B', 'RUN_C'][i];
      for (const t of tasks) expect(t.input).toEqual({ owner: goal });
    }

    // Nine distinct rows in total.
    const total = getDb().prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    expect(total.c).toBe(9);
  });

  it('dependency edges stay inside their own run', async () => {
    const rows = getDb()
      .prepare('SELECT run_id, task_id, depends_on FROM task_dependencies')
      .all() as { run_id: string; task_id: string; depends_on: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      // Both endpoints must exist within the SAME run.
      expect(stores.tasks.get({ runId: row.run_id, taskId: row.task_id })).not.toBeNull();
      expect(stores.tasks.get({ runId: row.run_id, taskId: row.depends_on })).not.toBeNull();
    }
  });

  it('a task lookup cannot reach another run\'s same-labelled task', async () => {
    const r1 = await (await post('/v1/runs', {
      goal: 'lookup-1', taskGraph: { tasks: [task('SHARED', { input: { which: 'first' } })], dependencies: [] }
    })).json();
    const r2 = await (await post('/v1/runs', {
      goal: 'lookup-2', taskGraph: { tasks: [task('SHARED', { input: { which: 'second' } })], dependencies: [] }
    })).json();

    const got1 = await (await fetch(`${base}/v1/runs/${r1.id}/tasks/SHARED`)).json();
    const got2 = await (await fetch(`${base}/v1/runs/${r2.id}/tasks/SHARED`)).json();

    expect(got1.input).toEqual({ which: 'first' });
    expect(got2.input).toEqual({ which: 'second' });
    expect(got1.runId).toBe(r1.id);
    expect(got2.runId).toBe(r2.id);

    // A task id from one run is not found under another run.
    const cross = await fetch(`${base}/v1/runs/${r1.id}/tasks/DOES_NOT_EXIST_HERE`);
    expect(cross.status).toBe(404);
  });

  it('executing one run leaves the other runs untouched', async () => {
    const mk = (goal: string) => post('/v1/runs', {
      goal, taskGraph: { tasks: [task('X', { input: { owner: goal } })], dependencies: [] }
    });
    const a = await (await mk('EXEC_A')).json();
    const b = await (await mk('EXEC_B')).json();

    await post(`/v1/runs/${a.id}/start`, {});
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await (await fetch(`${base}/v1/runs/${a.id}`)).json();
      if (run.state !== 'RUNNING' && run.state !== 'CREATED') break;
      if (Date.now() > deadline) throw new Error('run A did not finish');
      await new Promise((r) => setTimeout(r, 25));
    }

    const aTask = stores.tasks.get({ runId: a.id, taskId: 'X' })!;
    const bTask = stores.tasks.get({ runId: b.id, taskId: 'X' })!;

    expect(aTask.state).toBe('SUCCEEDED');
    expect(aTask.output).toBeDefined();
    // Run B's identically-named task is untouched: no output contamination.
    expect(bTask.state).toBe('PENDING');
    expect(bTask.output).toBeUndefined();
    expect(bTask.input).toEqual({ owner: 'EXEC_B' });
    expect(bTask.attempt).toBe(0);
  });

  it('duplicate ids WITHIN one run are still rejected (Phase A preserved)', async () => {
    const res = await post('/v1/runs', {
      goal: 'dupe-within-run',
      taskGraph: { tasks: [task('D'), task('D')], dependencies: [] }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('DUPLICATE_TASK_ID');
    expect(body.error.message).toBe('DUPLICATE_TASK_ID: D');
  });

  it('events carry both runId and taskId so they cannot be misattributed', async () => {
    const r = await (await post('/v1/runs', {
      goal: 'events', taskGraph: { tasks: [task('EV')], dependencies: [] }
    })).json();
    await post(`/v1/runs/${r.id}/start`, {});
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await (await fetch(`${base}/v1/runs/${r.id}`)).json();
      if (run.state !== 'RUNNING' && run.state !== 'CREATED') break;
      if (Date.now() > deadline) throw new Error('events run did not finish');
      await new Promise((x) => setTimeout(x, 25));
    }

    const events = stores.events.listByRun(r.id);
    expect(events.length).toBeGreaterThan(0);
    const taskEvents = events.filter((e) => e.type.startsWith('task.'));
    expect(taskEvents.length).toBeGreaterThan(0);

    // Every task event is attributable to exactly one (run, task) pair.
    for (const e of taskEvents) {
      const payload = e.payload as { runId?: string; taskId?: string };
      expect(payload.runId).toBe(r.id);
      expect(payload.taskId).toBe('EV');
    }

    // Execution events additionally carry ownership context. `task.ready` does
    // not, and should not: it is emitted before any claim exists, so there is no
    // worker, attempt or fence yet.
    const executionEvents = taskEvents.filter((e) => e.type !== 'task.ready');
    expect(executionEvents.length).toBeGreaterThan(0);
    for (const e of executionEvents) {
      const payload = e.payload as { workerId?: string; attempt?: number; fence?: number };
      expect(payload.workerId).toBeTruthy();
      expect(typeof payload.attempt).toBe('number');
      expect(typeof payload.fence).toBe('number');
    }
    expect(taskEvents.find((e) => e.type === 'task.ready')).toBeDefined();
  });
});
