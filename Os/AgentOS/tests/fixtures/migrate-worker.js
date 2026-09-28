/**
 * Boots exactly like a real AgentOS replica: open the database, run migrations,
 * report what it observed. Exits non-zero on any failure so the parent can count
 * genuine crashes. Plain Node against the compiled dist (see run-worker.js).
 */
const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist');
const { runMigrations } = require(path.join(DIST, 'db', 'migrations'));
const { getDb, closeDb } = require(path.join(DIST, 'db', 'connection'));

try {
  runMigrations();
  const db = getDb();
  const migrations = db.prepare('SELECT name FROM migrations ORDER BY name').pluck().all();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").pluck().all();
  process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, migrations, tables, indexes }));
  closeDb();
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({
    ok: false, pid: process.pid, error: e && e.message, code: e && e.code,
    // Where the throw actually originated -- guessing was wrong twice.
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 5).join(' | ') : null
  }));
  process.exit(1);
}
