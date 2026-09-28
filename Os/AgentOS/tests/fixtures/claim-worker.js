/**
 * Attempts exactly one atomic claim on one task, then reports the outcome.
 *
 * Plain Node against the COMPILED dist -- not tsx. N of these race for a single
 * READY task; exactly one must win. Real processes, real SQLite: an in-process
 * "race" would prove nothing, because better-sqlite3 is synchronous.
 */
const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist');

const { runMigrations } = require(path.join(DIST, 'db', 'migrations'));
const { createSqliteStores } = require(path.join(DIST, 'persistence', 'sqlite'));
const { createWorkerId } = require(path.join(DIST, 'runtime', 'WorkerIdentity'));

const runId = process.env.RUN_ID;
const taskId = process.env.TASK_ID;
const leaseMs = parseInt(process.env.LEASE_MS || '30000', 10);
const startAt = parseInt(process.env.START_AT || '0', 10);

runMigrations();
const stores = createSqliteStores();
const workerId = createWorkerId();

(async () => {
  // Align all racers on a wall-clock instant so they collide as tightly as the
  // OS allows, rather than being serialised by staggered process startup.
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const ticket = stores.tasks.claim({ runId, taskId, workerId, leaseMs, now: Date.now() });

  process.stdout.write(JSON.stringify({
    pid: process.pid,
    workerId,
    won: ticket !== null,
    fence: ticket ? ticket.fence : null,
    attempt: ticket ? ticket.attempt : null
  }));
  process.exit(0);
})();
