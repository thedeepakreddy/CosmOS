/**
 * A standalone AgentOS worker process, used by the multi-process tests.
 *
 * Plain Node against the COMPILED dist -- not tsx, which opens an IPC pipe per
 * process and exhausted the temp directory (`listen ENOSPC`) once enough
 * workers ran concurrently. Spawning the compiled artifact is also stronger
 * evidence: the thing under test is the thing that ships.
 *
 * Every executor invocation is appended to a shared JSONL file so the parent can
 * reconstruct, across processes, exactly who executed what and when.
 *
 * Env: DATABASE_URL EXEC_LOG RUN_IDS TASK_MS LEASE_MS POLL_MS MAX_MS
 *      WORKER_TAG DIE_AFTER_MS DIE_AFTER_EXEC_STARTS
 */
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist');

const { Supervisor } = require(path.join(DIST, 'engine', 'Supervisor'));
const { runMigrations } = require(path.join(DIST, 'db', 'migrations'));
const { createSqliteStores } = require(path.join(DIST, 'persistence', 'sqlite'));
const { createWorkerId } = require(path.join(DIST, 'runtime', 'WorkerIdentity'));

const LOG = process.env.EXEC_LOG;
const RUN_IDS = (process.env.RUN_IDS || '').split(',').filter(Boolean);
const TASK_MS = parseInt(process.env.TASK_MS || '40', 10);
const LEASE_MS = parseInt(process.env.LEASE_MS || '3000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '15', 10);
const MAX_MS = parseInt(process.env.MAX_MS || '60000', 10);
const DIE_AFTER_MS = process.env.DIE_AFTER_MS ? parseInt(process.env.DIE_AFTER_MS, 10) : null;
/**
 * Kill this process abruptly once it has STARTED this many executions.
 * Deterministic relative to real work, unlike a wall-clock timer -- so the crash
 * always lands with work genuinely in flight.
 */
const DIE_AFTER_EXEC_STARTS = process.env.DIE_AFTER_EXEC_STARTS
  ? parseInt(process.env.DIE_AFTER_EXEC_STARTS, 10) : null;
let execStarts = 0;

const workerId = createWorkerId();
/**
 * A caller-supplied label, so a test can identify a specific worker. The real
 * pid is logged alongside it as the process-level evidence.
 */
const tag = process.env.WORKER_TAG || 'untagged';
const append = (o) =>
  fs.appendFileSync(LOG, JSON.stringify(Object.assign(
    { pid: process.pid, workerId, tag, t: Date.now() }, o)) + '\n');

runMigrations();
const stores = createSqliteStores();

const executor = {
  async execute(_agent, task) {
    append({ ev: 'exec_start', runId: task.runId, taskId: task.id, attempt: task.attempt, fence: task.fence });
    execStarts++;
    if (DIE_AFTER_EXEC_STARTS !== null && execStarts >= DIE_AFTER_EXEC_STARTS) {
      // Abrupt death mid-execution: no exec_end, no lease release, no cleanup.
      process.kill(process.pid, 'SIGKILL');
    }
    await new Promise((r) => setTimeout(r, TASK_MS));
    append({ ev: 'exec_end', runId: task.runId, taskId: task.id, attempt: task.attempt, fence: task.fence });
    return { status: 'SUCCEEDED', output: { by: workerId, pid: process.pid, taskId: task.id, runId: task.runId } };
  }
};

const supervisor = new Supervisor(executor, { stores, workerId, leaseMs: LEASE_MS });

if (DIE_AFTER_MS !== null) {
  const t = setTimeout(() => process.kill(process.pid, 'SIGKILL'), DIE_AFTER_MS);
  if (t.unref) t.unref();
}

append({ ev: 'worker_boot', runIds: RUN_IDS });

const started = Date.now();
const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

(async () => {
  for (;;) {
    let allTerminal = true;
    for (const runId of RUN_IDS) {
      const run = stores.runs.getMeta(runId);
      if (!run) {
        // A run that does not exist YET is not finished.
        allTerminal = false;
        continue;
      }
      if (terminal.includes(run.state)) continue;
      allTerminal = false;
      try {
        if (run.state === 'CREATED') await supervisor.startRun(runId);
        else if (run.state === 'RUNNING') await supervisor.recoverRun(runId);
      } catch (e) { /* lost a race with another worker; harmless */ }
    }
    if (allTerminal || Date.now() - started > MAX_MS) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  append({ ev: 'worker_exit', states: RUN_IDS.map((r) => (stores.runs.getMeta(r) || {}).state) });
  supervisor.close();
  process.exit(0);
})();
