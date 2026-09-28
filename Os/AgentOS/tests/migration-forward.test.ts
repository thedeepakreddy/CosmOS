import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '../src/db/migrations';
import { closeDb, getDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * B2: forward migration from a real v0.1 database.
 *
 * Phase B changes task identity from a GLOBAL primary key to (run_id, task_id).
 * That is not an ALTER -- SQLite cannot change a primary key in place -- so the
 * tables are rebuilt. This test builds a database with the genuine v0.1 schema
 * and representative data, migrates it forward, and checks nothing was lost or
 * re-associated.
 */
const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const readMigration = (name: string) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8');

describe('Forward migration from v0.1 (B2)', () => {
  const dbPath = testDbPath('migration-forward');

  /** Build a database at exactly the v0.1 schema level, with data. */
  function seedV01Database(): void {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(readMigration('001_init.sql'));
    db.exec(readMigration('002_indexes.sql'));
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run('001_init.sql');
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run('002_indexes.sql');

    // Sanity: this really is the old global-primary-key shape.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get() as { sql: string }).sql;
    if (!/id TEXT PRIMARY KEY/.test(sql)) throw new Error('seed did not produce the v0.1 tasks schema');

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (id, version, name, description, role, capabilities)
       VALUES ('legacy-agent','1','Legacy','','worker','[]')`
    ).run();

    for (const [runId, goal, state] of [
      ['LEGACY_RUN_1', 'first legacy run', 'COMPLETED'],
      ['LEGACY_RUN_2', 'second legacy run', 'RUNNING']
    ]) {
      db.prepare(
        `INSERT INTO runs (id, goal, state, budget, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(runId, goal, state, JSON.stringify({ maxAgents: 2 }), now, now);
    }

    // v0.1 task ids are GLOBAL, so the two runs had to use different ids --
    // that limitation is exactly what Phase B removes.
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, run_id, name, description, agent_definition_id, state,
                          input, output, created_at, started_at, completed_at,
                          retries_allowed, retries_attempted)
       VALUES (?, ?, ?, '', 'legacy-agent', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertTask.run('L1_A', 'LEGACY_RUN_1', 'A', 'SUCCEEDED', JSON.stringify({ n: 1 }), JSON.stringify({ ok: 'A' }), now, now, now, 2, 1);
    insertTask.run('L1_B', 'LEGACY_RUN_1', 'B', 'SUCCEEDED', JSON.stringify({ n: 2 }), JSON.stringify({ ok: 'B' }), now, now, now, 0, 0);
    insertTask.run('L2_A', 'LEGACY_RUN_2', 'A', 'RUNNING',   JSON.stringify({ n: 3 }), null, now, now, null, 3, 1);
    insertTask.run('L2_B', 'LEGACY_RUN_2', 'B', 'PENDING',   JSON.stringify({ n: 4 }), null, now, null, null, 0, 0);

    const insertDep = db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)');
    insertDep.run('L1_B', 'L1_A');
    insertDep.run('L2_B', 'L2_A');

    db.prepare('INSERT INTO events (id, run_id, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run('ev-legacy-1', 'LEGACY_RUN_1', 'run.started', JSON.stringify({ runId: 'LEGACY_RUN_1' }), now);

    db.close();
  }

  beforeEach(() => {
    closeDb();
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
  });

  afterAll(() => { closeDb(); removeDb(dbPath); });

  it('migrates a populated v0.1 database forward with no data loss', () => {
    seedV01Database();
    runMigrations();
    const db = getDb();
    const stores = createSqliteStores();

    // The migration ledger records every file exactly once.
    const applied = db.prepare('SELECT name FROM migrations ORDER BY name').pluck().all() as string[];
    expect(applied).toContain('003_task_identity_and_ownership.sql');
    expect(new Set(applied).size).toBe(applied.length);

    // Schema is now run-scoped.
    const tasksSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get() as { sql: string }).sql;
    expect(tasksSql).toContain('PRIMARY KEY (run_id, task_id)');
    expect(tasksSql).toContain('owner_id');
    expect(tasksSql).toContain('lease_expires_at');
    expect(tasksSql).toContain('fence');
    expect(tasksSql).toContain('attempt');

    // All four tasks survived, still attached to their ORIGINAL runs.
    expect((db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c).toBe(4);
    const r1 = stores.tasks.listByRun('LEGACY_RUN_1');
    const r2 = stores.tasks.listByRun('LEGACY_RUN_2');
    expect(r1.map((t) => t.id).sort()).toEqual(['L1_A', 'L1_B']);
    expect(r2.map((t) => t.id).sort()).toEqual(['L2_A', 'L2_B']);

    // Field-level preservation, including outputs and retry counters.
    const l1a = stores.tasks.get({ runId: 'LEGACY_RUN_1', taskId: 'L1_A' })!;
    expect(l1a.state).toBe('SUCCEEDED');
    expect(l1a.output).toEqual({ ok: 'A' });
    expect(l1a.input).toEqual({ n: 1 });
    expect(l1a.retriesAllowed).toBe(2);
    expect(l1a.retriesAttempted).toBe(1);

    // Ownership columns start clean; a task that had already run is credited
    // with one attempt, so counters never appear to go backwards.
    expect(l1a.ownerId).toBeUndefined();
    expect(l1a.leaseExpiresAt).toBeUndefined();
    expect(l1a.fence).toBe(0);
    expect(l1a.attempt).toBe(1);
    expect(stores.tasks.get({ runId: 'LEGACY_RUN_2', taskId: 'L2_B' })!.attempt).toBe(0);

    // Dependencies were re-scoped to the correct run.
    const deps = db.prepare('SELECT run_id, task_id, depends_on FROM task_dependencies ORDER BY run_id').all() as any[];
    expect(deps).toEqual([
      { run_id: 'LEGACY_RUN_1', task_id: 'L1_B', depends_on: 'L1_A' },
      { run_id: 'LEGACY_RUN_2', task_id: 'L2_B', depends_on: 'L2_A' }
    ]);

    // Runs, agents and events untouched.
    expect((db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c).toBe(2);
    expect(stores.agents.get('legacy-agent')).not.toBeNull();
    expect(stores.events.listByRun('LEGACY_RUN_1')).toHaveLength(1);
    expect(stores.runs.get('LEGACY_RUN_1')!.budget).toEqual({ maxAgents: 2 });

    // Referential integrity intact after the rebuild.
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Indexes rebuilt.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .pluck().all() as string[];
    expect(indexes).toContain('idx_tasks_run_id_state');
    expect(indexes).toContain('idx_tasks_state_lease');
    expect(indexes).toContain('idx_task_dependencies_depends_on');
  });

  it('the migrated database enforces the new identity invariant', () => {
    seedV01Database();
    runMigrations();
    const stores = createSqliteStores();
    const now = new Date().toISOString();

    // The id "L1_A" already exists in LEGACY_RUN_1. A different run may now use
    // the same id -- impossible before Phase B.
    stores.runs.save({
      id: 'NEW_RUN', goal: 'post-migration', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: [{
          id: 'L1_A', runId: 'NEW_RUN', name: 'reused id', description: '',
          agentDefinitionId: 'legacy-agent', state: 'PENDING', createdAt: now,
          retriesAllowed: 0, retriesAttempted: 0
        }],
        dependencies: []
      }
    });

    const legacy = stores.tasks.get({ runId: 'LEGACY_RUN_1', taskId: 'L1_A' })!;
    const fresh = stores.tasks.get({ runId: 'NEW_RUN', taskId: 'L1_A' })!;
    expect(legacy.name).toBe('A');
    expect(legacy.output).toEqual({ ok: 'A' });   // untouched by the new run
    expect(fresh.name).toBe('reused id');
    expect(fresh.output).toBeUndefined();
  });

  it('is idempotent: migrating an already-migrated database changes nothing', () => {
    seedV01Database();
    runMigrations();
    const db = getDb();
    const before = {
      tasks: db.prepare('SELECT COUNT(*) AS c FROM tasks').get(),
      deps: db.prepare('SELECT COUNT(*) AS c FROM task_dependencies').get(),
      migrations: db.prepare('SELECT name FROM migrations ORDER BY name').pluck().all()
    };

    runMigrations();
    runMigrations();

    expect(db.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual(before.tasks);
    expect(db.prepare('SELECT COUNT(*) AS c FROM task_dependencies').get()).toEqual(before.deps);
    expect(db.prepare('SELECT name FROM migrations ORDER BY name').pluck().all()).toEqual(before.migrations);
  });

  it('a failing migration rolls back and is never recorded as applied', () => {
    seedV01Database();
    const db = new Database(dbPath);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;

    // Simulate a migration that fails partway: valid DDL, then a statement that
    // cannot succeed. Everything must roll back together.
    const tx = db.transaction(() => {
      db.exec('CREATE TABLE half_migrated (x TEXT);');
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run('999_broken.sql');
      db.exec('INSERT INTO tasks (id, run_id) VALUES (NULL, NULL);'); // NOT NULL violation
    });
    expect(() => tx.immediate()).toThrow();

    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='half_migrated'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM migrations WHERE name='999_broken.sql'").get()).toEqual({ c: 0 });
    expect((db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c).toBe(before);
    db.close();
  });
});
