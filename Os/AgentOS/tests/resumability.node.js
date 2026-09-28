/**
 * Crash-recovery regression check (A10).
 *
 * The previous version of this file ended in `runTest().catch(console.error)`,
 * was referenced by no npm script, and was not collected by vitest (`.node.js`
 * is outside the default include pattern). It could error and still exit 0 --
 * and during the audit it did exactly that. It is the evidence the v0.1
 * certification rested on, and it could not report failure.
 *
 * This version:
 *   - asserts every claim it makes, including the ones it previously only printed
 *   - kills process 1 with SIGKILL (a genuine crash, not a graceful SIGINT)
 *   - binds a random high port instead of a fixed 3000
 *   - keeps its database in the OS temp directory
 *   - exits non-zero on ANY failure, including an unhandled rejection
 *
 * Run: npm run test:recovery   (requires `npm run build` first)
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const DIST_CLIENT = path.join(__dirname, '..', 'dist', 'sdk', 'client.js');
if (!fs.existsSync(DIST_CLIENT)) {
  console.error('FAIL: dist/ not built. Run `npm run build` before `npm run test:recovery`.');
  process.exit(1);
}
const { AgentOSClient } = require(DIST_CLIENT);

const PORT = 39000 + Math.floor(Math.random() * 2000);
const DB_PATH = path.join(os.tmpdir(), `agentos-test-resumability-${process.pid}.db`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

function removeDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* not present */ }
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn('node', [path.join(__dirname, 'test-server.js')], {
      env: {
        ...process.env,
        DATABASE_URL: DB_PATH,
        PORT: String(PORT),
        LOG_LEVEL: 'silent',
        // Short lease so abandoned work becomes reclaimable quickly. Production
        // uses the 30s default; this only changes how long the test waits.
        AGENTOS_LEASE_MS: process.env.AGENTOS_LEASE_MS || '2000'
      },
      cwd: path.join(__dirname, '..')
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('server did not report listening within 15s')); }
    }, 15000);

    server.stdout.on('data', (d) => {
      if (!settled && /listening/i.test(d.toString())) {
        settled = true; clearTimeout(timer); resolve(server);
      }
    });
    server.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('server exited with ' + code)); }
    });
    server.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
  });
}

async function waitFor(fn, description, budgetMs = 15000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for: ${description}`);
    await wait(50);
  }
}

async function runTest() {
  removeDb();

  log('Starting process 1...');
  const server1 = await startServer();
  log('Process 1 pid:', server1.pid);

  const client = new AgentOSClient(`http://127.0.0.1:${PORT}`);

  await client.createAgent({
    id: 'slow-worker', version: '1', name: 'Worker', description: '', role: '', capabilities: []
  });

  const run = await client.createRun({
    goal: 'Resume Test',
    taskGraph: {
      tasks: [
        { id: 'A', name: 'A', description: '', agentDefinitionId: 'slow-worker', state: 'PENDING', input: { delayMs: 100 } },
        { id: 'B', name: 'B', description: '', agentDefinitionId: 'slow-worker', state: 'PENDING', input: { delayMs: 500 } },
        { id: 'C', name: 'C', description: '', agentDefinitionId: 'slow-worker', state: 'PENDING', input: { delayMs: 500 } }
      ],
      dependencies: [
        { taskId: 'B', dependsOn: 'A' },
        { taskId: 'C', dependsOn: 'A' }
      ]
    }
  });
  assert.ok(run.id, 'run should have been created');
  log('Created run:', run.id);

  await client.startRun(run.id);

  await waitFor(async () => {
    const { tasks } = await client.getTasks(run.id);
    return tasks.find((t) => t.id === 'A')?.state === 'SUCCEEDED';
  }, 'task A to succeed');
  log('Task A succeeded.');

  log('Killing process 1 (SIGKILL -- genuine crash, no graceful shutdown)...');
  server1.kill('SIGKILL');
  await waitFor(async () => server1.killed && server1.exitCode !== null || server1.signalCode === 'SIGKILL',
    'process 1 to die', 10000).catch(() => {});
  await wait(500);

  log('Starting process 2...');
  const server2 = await startServer();
  log('Process 2 pid:', server2.pid);
  assert.notStrictEqual(server2.pid, server1.pid, 'process 2 must be a different OS process');

  try {
    // --- durability: completed work survived the crash -----------------------
    const { tasks: afterCrash } = await client.getTasks(run.id);
    const a = afterCrash.find((t) => t.id === 'A');
    assert.ok(a, 'task A should still exist after the crash');
    assert.strictEqual(a.state, 'SUCCEEDED', 'completed work must survive a crash');
    assert.ok(a.output !== undefined && a.output !== null, 'task A output must be preserved');

    // --- recovery: the run continues in the new process ----------------------
    log('Recovering run in process 2 (lease-based, NOT resume)...');
    await client.recoverRun(run.id);

    const finalRun = await waitFor(async () => {
      const r = await client.getRun(run.id);
      return ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.state) ? r : null;
    }, 'run to reach a terminal state', 30000);

    assert.strictEqual(finalRun.state, 'COMPLETED', `run should complete, got ${finalRun.state}`);

    // --- these were previously PRINTED but never asserted --------------------
    const { tasks: finalTasks } = await client.getTasks(run.id);
    assert.strictEqual(finalTasks.length, 3, 'all three tasks should be present');
    for (const id of ['A', 'B', 'C']) {
      const t = finalTasks.find((x) => x.id === id);
      assert.ok(t, `task ${id} must exist`);
      assert.strictEqual(t.state, 'SUCCEEDED', `task ${id} should be SUCCEEDED, got ${t.state}`);
    }

    // Task A completed before the crash and must NOT have been re-run.
    const finalA = finalTasks.find((t) => t.id === 'A');
    assert.strictEqual(finalA.retriesAttempted, 0, 'task A must not have been retried');
    assert.strictEqual(finalA.attempt, 1, 'task A must have executed exactly once (attempt 1)');
    assert.strictEqual(finalA.ownerId, undefined, 'a completed task must hold no lease');
    assert.strictEqual(
      finalA.completedAt, a.completedAt,
      'task A completedAt must be unchanged -- completed work must not be re-executed'
    );

    log('');
    log('Final task states:');
    for (const t of finalTasks) log(`  - ${t.id}: ${t.state} (retriesAttempted=${t.retriesAttempted})`);
    log('');
    log('PASS: crash recovery preserved completed work and finished the remaining tasks.');
  } finally {
    server2.kill('SIGKILL');
    removeDb();
  }
}

// Any failure -- assertion, rejection, or thrown error -- exits non-zero.
process.on('unhandledRejection', (err) => {
  console.error('FAIL (unhandled rejection):', err);
  process.exit(1);
});

runTest().then(
  () => process.exit(0),
  (err) => {
    console.error('FAIL:', err && err.message ? err.message : err);
    removeDb();
    process.exit(1);
  }
);
