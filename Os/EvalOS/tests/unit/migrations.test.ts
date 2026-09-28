import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';

describe('Database Migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    // In-memory database for testing
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should apply migrations to an empty database successfully', () => {
    runMigrations(db);
    
    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const tableNames = tables.map(t => t.name);
    
    expect(tableNames).toContain('_migrations');
    expect(tableNames).toContain('suites');
    expect(tableNames).toContain('evaluation_cases');
  });

  it('should not fail or destructively rerun when executed twice', () => {
    runMigrations(db);
    runMigrations(db); // second time should be a no-op

    const count = db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as any;
    expect(count.c).toBe(1); // Only 1 migration file exists so far
    
    const migration = db.prepare('SELECT name FROM _migrations').get() as any;
    expect(migration.name).toBe('001_initial_schema.sql');
  });
});
