import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * A6: migration cold-boot race.
 *
 * The audit reproduced `UNIQUE constraint failed: migrations.name` crashing
 * 4-of-6 and then 1-of-6 processes booting together against a fresh database --
 * timing-dependent, the signature of a genuine check-then-act race. The read of
 * the applied-migration set happened outside the transaction that applied them.
 *
 * These are real OS processes, not simulated restarts.
 */
const WORKER = path.join(__dirname, 'fixtures', 'migrate-worker.js');

/**
 * Derived from disk rather than hardcoded, so adding a migration does not
 * silently make this test assert a stale expectation.
 */
const EXPECTED_MIGRATIONS = fs
  .readdirSync(path.join(__dirname, '..', 'src', 'db', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

/**
 * Indexes the current migration set is expected to leave behind -- derived by
 * reading the migration SQL, not hardcoded, so adding a migration cannot leave
 * this asserting a stale expectation.
 *
 * Indexes created on a table that a LATER migration drops and rebuilds do not
 * survive, so only indexes declared at or after the last rebuild count.
 */
const EXPECTED_INDEXES = (() => {
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const found = new Set<string>();
  for (const file of EXPECTED_MIGRATIONS) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
    // A rebuild drops the table, taking its indexes with it.
    for (const m of sql.matchAll(/DROP TABLE\s+(\w+)/gi)) {
      for (const name of [...found]) {
        if (name.includes(m[1].replace(/s$/, ''))) found.delete(name);
      }
    }
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
})();

interface WorkerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function bootWorker(dbPath: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], {
      env: { ...process.env, DATABASE_URL: dbPath, LOG_LEVEL: 'silent' },
      cwd: path.join(__dirname, '..')
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    // A spawn-level failure (EAGAIN/EMFILE under process pressure) emits 'error',
    // not a worker crash. Capture it so a failure is self-explaining rather than
    // an anonymous non-zero exit. This does not soften the assertion: such a run
    // still fails -- it just says why.
    child.on('error', (e: NodeJS.ErrnoException) => {
      stderr += `SPAWN_ERROR ${e.code ?? ''} ${e.message}\n`;
    });
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe('Concurrent migration cold boot (A6)', () => {
  const dbPath = testDbPath('migration-race');

  beforeEach(() => {
    removeDb(dbPath);
  });
  afterAll(() => removeDb(dbPath));

  it('6 simultaneous processes all boot against one fresh database', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => bootWorker(dbPath)));

    const succeeded = results.filter((r) => r.exitCode === 0);
    const failed = results.filter((r) => r.exitCode !== 0);

    // The exact failure the audit reproduced must not reappear.
    const raceCrashes = results.filter(
      (r) => /UNIQUE constraint failed: migrations\.name/.test(r.stdout + r.stderr)
    );

    // Surface the actual worker output on failure. A worker can in principle
    // exit non-zero for reasons unrelated to A6 (e.g. the tsx loader failing to
    // start under heavy machine load), and that must be distinguishable from a
    // genuine migration race rather than silently tolerated.
    const diagnostics = failed
      .map((r, i) => `  worker[${i}] exit=${r.exitCode}\n    stdout: ${r.stdout.trim()}\n    stderr: ${r.stderr.trim().split('\n').slice(0, 5).join(' | ')}`)
      .join('\n');

    expect(raceCrashes, `migration race reappeared:\n${diagnostics}`).toHaveLength(0);
    expect(failed, `worker(s) exited non-zero:\n${diagnostics}`).toHaveLength(0);
    expect(succeeded).toHaveLength(6);

    // Every process must observe the same, complete migration state.
    const payloads = succeeded.map((r) => JSON.parse(r.stdout));
    for (const p of payloads) {
      expect(p.ok).toBe(true);
      expect(p.migrations).toEqual(EXPECTED_MIGRATIONS);
      expect(p.tables).toContain('runs');
      expect(p.tables).toContain('tasks');
      expect(p.tables).toContain('task_dependencies');
      expect(p.tables).toContain('events');
      expect(p.indexes).toEqual(EXPECTED_INDEXES);
    }

    // Distinct PIDs: proof these were genuinely separate OS processes.
    expect(new Set(payloads.map((p) => p.pid)).size).toBe(6);
  });

  it('records each migration exactly once, with no duplicate rows', async () => {
    await Promise.all(Array.from({ length: 6 }, () => bootWorker(dbPath)));

    const check = await bootWorker(dbPath);
    expect(check.exitCode).toBe(0);
    const payload = JSON.parse(check.stdout);

    // A duplicate insert would either have crashed a worker or produced repeats.
    expect(payload.migrations).toEqual(EXPECTED_MIGRATIONS);
    expect(new Set(payload.migrations).size).toBe(payload.migrations.length);
  });

  it('is idempotent: re-booting an already-migrated database is a no-op', async () => {
    const first = await bootWorker(dbPath);
    expect(first.exitCode).toBe(0);

    const again = await Promise.all(Array.from({ length: 4 }, () => bootWorker(dbPath)));
    for (const r of again) {
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).migrations).toEqual(EXPECTED_MIGRATIONS);
    }
  });
});
