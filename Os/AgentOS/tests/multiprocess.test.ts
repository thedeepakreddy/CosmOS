import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '../src/db/migrations';
import { closeDb, getDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { Task } from '../src/index';
import { testDbPath, removeDb, testArtifactPath } from './helpers/testDb';

/**
 * B12 + B13 + B14: the ownership protocol under genuine multi-process load.
 *
 * The audit's headline failure: two live processes on one SQLite file executed
 * 8 tasks 11 times, three of them simultaneously on different PIDs, because
 * "recovery" blindly reset every RUNNING task to READY.
 *
 * Everything here uses real OS processes and real SQLite. Per B29, a mock cannot
 * establish process ownership, crash behaviour or contention.
 */
const WORKER = path.join(__dirname, 'fixtures', 'run-worker.js');
const REPO = path.join(__dirname, '..');

interface ExecEvent {
  ev: string;
  pid: number;
  workerId: string;
  tag: string;
  t: number;
  runId?: string;
  taskId?: string;
  attempt?: number;
  fence?: number;
}

interface Execution {
  key: string;
  workerId: string;
  pid: number;
  tag: string;
  attempt: number;
  fence: number;
  start: number;
  end: number | null;
}

describe('Multi-process ownership (B12, B13, B14)', () => {
  const dbPath = testDbPath('multiprocess');
  const logPath = `${testArtifactPath('multiprocess')}.jsonl`;
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  const spawned: ChildProcess[] = [];
  /**
   * When each worker process exited, keyed by tag.
   *
   * A SIGKILLed worker never writes its exec_end, so its last execution looks
   * open-ended in the log. Treating that as "still running" would report a false
   * overlap with the worker that later reclaims the task. A dead process is not
   * executing anything, so an unfinished execution is bounded by its worker's
   * observed exit. Workers that are still ALIVE have no exit time and remain
   * unbounded -- so a genuine concurrent duplicate is still caught.
   */
  let workerExitAt: Map<string, number>;
  /** Whatever each worker printed, and how it exited -- for diagnosing boot failures. */
  let workerOutput: Map<string, string>;
  let workerExitInfo: Map<string, string>;
  /** PIDs that executed work across the contention scenarios (see below). */
  const pidsObservedAcrossScenarios: number[] = [];

  beforeEach(() => {
    for (const c of spawned.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    closeDb();
    removeDb(dbPath);
    try { fs.unlinkSync(logPath); } catch { /* absent */ }
    process.env.DATABASE_URL = dbPath;
    workerExitAt = new Map();
    workerOutput = new Map();
    workerExitInfo = new Map();
    runMigrations();
    stores = createSqliteStores();
    stores.agents.save({ id: 'mpw', version: '1', name: 'mpw', description: '', role: '', capabilities: [] });
  });

  afterAll(() => {
    for (const c of spawned.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    closeDb();
    removeDb(dbPath);
    // AGENTOS_KEEP_EXEC_LOG leaves the execution log in place for inspection.
    if (!process.env.AGENTOS_KEEP_EXEC_LOG) {
      try { fs.unlinkSync(logPath); } catch { /* absent */ }
    }
  });

  function seedRun(runId: string, taskIds: string[], maxAgents?: number): void {
    const now = new Date().toISOString();
    const tasks: Task[] = taskIds.map((id) => ({
      id, runId, name: id, description: '', agentDefinitionId: 'mpw',
      state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
    }));
    stores.runs.save({
      id: runId, goal: 'mp', state: 'CREATED', createdAt: now,
      ...(maxAgents === undefined ? {} : { budget: { maxAgents } }),
      taskGraph: { tasks, dependencies: [] }
    });
  }

  function startWorker(runIds: string[], env: Record<string, string> = {}): ChildProcess {
    const tag = env.WORKER_TAG ?? `w${spawned.length}`;
    const child = spawn(process.execPath, [WORKER], {
      cwd: REPO,
      // Capture worker output. With stdio ignored, a worker that dies during
      // boot is silent and the only symptom is a boot-barrier timeout with no
      // explanation -- which is exactly what happened.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: dbPath,
        EXEC_LOG: logPath,
        RUN_IDS: runIds.join(','),
        LOG_LEVEL: 'silent',
        TASK_MS: '25',
        LEASE_MS: '3000',
        POLL_MS: '10',
        MAX_MS: '90000',
        WORKER_TAG: tag,
        ...env
      }
    });
    child.stdout?.on('data', (d) => { workerOutput.set(tag, (workerOutput.get(tag) ?? '') + d); });
    child.stderr?.on('data', (d) => { workerOutput.set(tag, (workerOutput.get(tag) ?? '') + d); });
    child.on('exit', (code, signal) => {
      workerExitAt.set(tag, Date.now());
      workerExitInfo.set(tag, `exit=${code} signal=${signal}`);
    });
    spawned.push(child);
    return child;
  }

  /**
   * Block until `n` workers have booted.
   *
   * Without this, a fast run can finish inside one worker before the others have
   * even started (tsx takes a few hundred ms to boot), so a contention test
   * would silently stop testing contention.
   */
  async function waitForWorkerBoots(n: number, budgetMs = 90_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const boots = readLog().filter((e) => e.ev === 'worker_boot').length;
      if (boots >= n) return;
      if (Date.now() > deadline) {
        const diag = [...workerExitInfo.entries()]
          .map(([tag, info]) => `  ${tag}: ${info}\n    ${(workerOutput.get(tag) ?? '(no output)').trim().split('\n').slice(0, 6).join('\n    ')}`)
          .join('\n');
        throw new Error(`only ${boots}/${n} workers booted\n${diag || '  (no worker exited; they are just slow)'}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Block until a predicate over the execution log holds. */
  async function waitForLog(
    predicate: (events: ExecEvent[]) => boolean,
    what: string,
    budgetMs = 30_000
  ): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (predicate(readLog())) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const readLog = (): ExecEvent[] =>
    fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

  /** Pair exec_start / exec_end into intervals keyed by run+task+worker+attempt. */
  function executions(events: ExecEvent[]): Execution[] {
    const open = new Map<string, Execution>();
    const done: Execution[] = [];
    for (const e of events) {
      if (e.ev !== 'exec_start' && e.ev !== 'exec_end') continue;
      const id = `${e.runId}|${e.taskId}|${e.workerId}|${e.attempt}`;
      if (e.ev === 'exec_start') {
        const exec: Execution = {
          key: `${e.runId}|${e.taskId}`, workerId: e.workerId, pid: e.pid, tag: e.tag,
          attempt: e.attempt!, fence: e.fence!, start: e.t, end: null
        };
        open.set(id, exec);
        done.push(exec);
      } else {
        const exec = open.get(id);
        if (exec) { exec.end = e.t; open.delete(id); }
      }
    }
    // Anything still open belongs to a worker that never logged exec_end. If
    // that worker has exited, its execution ended no later than its exit.
    for (const exec of open.values()) {
      const exitedAt = workerExitAt.get(exec.tag);
      if (exitedAt !== undefined) exec.end = exitedAt;
    }
    return done;
  }

  /** Executions of the SAME task whose time intervals overlap. */
  function simultaneousDuplicates(execs: Execution[]): Array<[Execution, Execution]> {
    const byTask = new Map<string, Execution[]>();
    for (const e of execs) {
      if (!byTask.has(e.key)) byTask.set(e.key, []);
      byTask.get(e.key)!.push(e);
    }
    const clashes: Array<[Execution, Execution]> = [];
    for (const list of byTask.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const aEnd = a.end ?? Number.MAX_SAFE_INTEGER;
          const bEnd = b.end ?? Number.MAX_SAFE_INTEGER;
          if (a.start < bEnd && b.start < aEnd) clashes.push([a, b]);
        }
      }
    }
    return clashes;
  }

  async function waitForTerminal(runIds: string[], budgetMs: number): Promise<Record<string, string>> {
    const deadline = Date.now() + budgetMs;
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
    for (;;) {
      const states: Record<string, string> = {};
      let all = true;
      for (const id of runIds) {
        const run = stores.runs.get(id);
        states[id] = run?.state ?? 'MISSING';
        if (!run || !terminal.includes(run.state)) all = false;
      }
      if (all || Date.now() > deadline) return states;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // ---- detector integrity -------------------------------------------------
  // The overlap detector is the instrument every claim in this file rests on.
  // If it were blind, every test here would pass vacuously.
  describe('overlap detector self-test', () => {
    const ev = (o: Partial<ExecEvent>): ExecEvent =>
      ({ ev: 'exec_start', pid: 1, workerId: 'w', tag: 'w', t: 0, ...o } as ExecEvent);

    it('detects two workers running the same task at the same time', () => {
      const events: ExecEvent[] = [
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 100 }),
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 120 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 200 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 220 })
      ];
      expect(simultaneousDuplicates(executions(events))).toHaveLength(1);
    });

    it('accepts two SEQUENTIAL executions of the same task (retry / reclaim)', () => {
      const events: ExecEvent[] = [
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 100 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 200 }),
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 300 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 400 })
      ];
      expect(simultaneousDuplicates(executions(events))).toHaveLength(0);
    });

    it('an unfinished execution from a STILL-LIVE worker is treated as overlapping', () => {
      // No exit recorded for tag 'A', so its execution stays unbounded.
      const events: ExecEvent[] = [
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 100 }),
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 5_000 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 5_100 })
      ];
      expect(simultaneousDuplicates(executions(events))).toHaveLength(1);
    });

    it('the same case is NOT an overlap once the first worker is known to have died', () => {
      workerExitAt.set('A', 200);
      const events: ExecEvent[] = [
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 100 }),
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 5_000 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 5_100 })
      ];
      expect(simultaneousDuplicates(executions(events))).toHaveLength(0);
    });

    it('but a dead worker still overlaps anything that ran BEFORE it died', () => {
      workerExitAt.set('A', 5_000);
      const events: ExecEvent[] = [
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 1, fence: 1, workerId: 'A', tag: 'A', pid: 10, t: 100 }),
        ev({ ev: 'exec_start', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 200 }),
        ev({ ev: 'exec_end', runId: 'R', taskId: 'T', attempt: 2, fence: 2, workerId: 'B', tag: 'B', pid: 11, t: 300 })
      ];
      expect(simultaneousDuplicates(executions(events))).toHaveLength(1);
    });
  });

  // ---- B13: healthy contention -------------------------------------------
  describe('healthy contention (B13)', () => {
    const scenarios = [
      { workers: 2, tasks: 50 },
      { workers: 4, tasks: 100 },
      { workers: 6, tasks: 200 }
    ];

    for (const { workers, tasks } of scenarios) {
      it(`${workers} worker processes / ${tasks} tasks / 1 run: zero duplicate execution`, async () => {
        const runId = `MP_${workers}_${tasks}`;
        const taskIds = Array.from({ length: tasks }, (_, i) => `T${i}`);

        // Boot every worker FIRST. They poll for a run that does not exist yet,
        // so none can race ahead and finish the run alone.
        for (let i = 0; i < workers; i++) startWorker([runId], { WORKER_TAG: `w${i}`, TASK_MS: '60' });
        await waitForWorkerBoots(workers);

        // Cap concurrency at the worker count and give each task real duration.
        // Without this, one worker can drain the whole queue at the default
        // ceiling of 10 before the others complete a poll cycle -- and the test
        // would then be asserting against no contention at all.
        seedRun(runId, taskIds, workers);
        const states = await waitForTerminal([runId], 90_000);

        const events = readLog();
        const execs = executions(events);
        const clashes = simultaneousDuplicates(execs);
        const pids = new Set(events.filter((e) => e.ev === 'exec_start').map((e) => e.pid));
        const persisted = stores.tasks.listByRun(runId);

        // MANDATORY: no two workers ever ran the same task at the same time.
        expect(clashes, JSON.stringify(clashes.slice(0, 3), null, 2)).toHaveLength(0);

        // Every task ran, exactly once, and none was lost.
        expect(execs).toHaveLength(tasks);
        expect(new Set(execs.map((e) => e.key)).size).toBe(tasks);
        expect(persisted).toHaveLength(tasks);
        expect(persisted.every((t) => t.state === 'SUCCEEDED')).toBe(true);
        expect(persisted.every((t) => t.attempt === 1)).toBe(true);

        // NOTE on what is and is not asserted here.
        //
        // Every safety property above is unconditional: no duplicate execution,
        // no lost task, exactly one execution each, correct terminal state.
        //
        // Work *distribution* is NOT asserted per-scenario, because AgentOS does
        // not guarantee it. A worker holding claims re-dispatches synchronously
        // the moment one finishes, so an incumbent has a structural advantage
        // and a second worker can legitimately win nothing on a short run. That
        // is a fairness property, not a correctness one -- see the file-level
        // assertion below, and the crash test, for genuine multi-PID evidence.
        expect(pids.size).toBeGreaterThanOrEqual(1);
        pidsObservedAcrossScenarios.push(...pids);

        // No lease left dangling, and the run reached the right terminal state.
        expect(persisted.every((t) => t.ownerId === undefined)).toBe(true);
        expect(states[runId]).toBe('COMPLETED');

        // No stale write was accepted: each task's output names the worker whose
        // execution is recorded in the log for that task.
        for (const t of persisted) {
          const exec = execs.find((e) => e.key === `${runId}|${t.id}`)!;
          expect((t.output as { by: string }).by).toBe(exec.workerId);
          expect((t.output as { runId: string }).runId).toBe(runId);
        }
      }, 120_000);
    }

    it('work was genuinely spread across multiple OS processes somewhere', () => {
      // Distribution is not guaranteed on any single short run, but across the
      // 2/4/6-worker scenarios it must have happened at least once -- otherwise
      // these are not multi-process tests at all and every claim above is vacuous.
      const distinct = new Set(pidsObservedAcrossScenarios);
      expect(distinct.size, `only PIDs ${[...distinct].join(',')} ever executed work`)
        .toBeGreaterThan(1);
    });

    it('the global concurrency ceiling holds ACROSS processes', async () => {
      // The audit measured configured=3 but a global peak of 6 across two
      // processes, because the ceiling was evaluated per-process.
      const runId = 'MP_CONC';
      const taskIds = Array.from({ length: 60 }, (_, i) => `C${i}`);
      const now = new Date().toISOString();
      stores.runs.save({
        // Seeded as PLANNING: run-worker only acts on CREATED or RUNNING, so the
        // run is inert until every worker has booted and we release it.
        id: runId, goal: 'conc', state: 'PLANNING', createdAt: now,
        budget: { maxAgents: 3 },
        taskGraph: {
          tasks: taskIds.map((id) => ({
            id, runId, name: id, description: '', agentDefinitionId: 'mpw',
            state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
          })),
          dependencies: []
        }
      });

      for (let i = 0; i < 4; i++) startWorker([runId], { TASK_MS: '40', WORKER_TAG: `c${i}` });
      await waitForWorkerBoots(4);
      expect(stores.runs.compareAndSetState(runId, ['PLANNING'], 'CREATED')).toBe(true);
      const states = await waitForTerminal([runId], 90_000);

      const execs = executions(readLog());
      // Sweep the timeline: maximum simultaneously-open executions across ALL
      // processes.
      const points = [
        ...execs.map((e) => ({ t: e.start, d: 1 })),
        ...execs.map((e) => ({ t: e.end ?? Number.MAX_SAFE_INTEGER, d: -1 }))
      ].sort((a, b) => a.t - b.t || a.d - b.d);
      let cur = 0;
      let peak = 0;
      for (const p of points) { cur += p.d; peak = Math.max(peak, cur); }

      expect(states[runId]).toBe('COMPLETED');
      expect(execs).toHaveLength(60);
      expect(simultaneousDuplicates(execs)).toHaveLength(0);
      expect(peak).toBeLessThanOrEqual(3);
      expect(new Set(execs.map((e) => e.pid)).size).toBeGreaterThan(1);
    }, 120_000);
  });

  // ---- B14: several runs sharing task ids --------------------------------
  it('three runs sharing the ids A/B/C stay fully isolated across workers', async () => {
    const runIds = ['MR_A', 'MR_B', 'MR_C'];
    for (const id of runIds) seedRun(id, ['A', 'B', 'C']);

    for (let i = 0; i < 4; i++) startWorker(runIds, { WORKER_TAG: `mr${i}` });
    await waitForWorkerBoots(4);
    const states = await waitForTerminal(runIds, 90_000);

    const execs = executions(readLog());
    expect(simultaneousDuplicates(execs)).toHaveLength(0);
    // 3 runs x 3 tasks, each executed exactly once.
    expect(execs).toHaveLength(9);
    expect(new Set(execs.map((e) => e.key)).size).toBe(9);

    for (const runId of runIds) {
      expect(states[runId]).toBe('COMPLETED');
      const tasks = stores.tasks.listByRun(runId);
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.id).sort()).toEqual(['A', 'B', 'C']);
      for (const t of tasks) {
        expect(t.state).toBe('SUCCEEDED');
        expect(t.attempt).toBe(1);
        // No cross-run output contamination: the output names THIS run.
        expect((t.output as { runId: string }).runId).toBe(runId);
        expect((t.output as { taskId: string }).taskId).toBe(t.id);
      }
    }

    const total = getDb().prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    expect(total.c).toBe(9);
  }, 120_000);

  // ---- B12: crash during execution ---------------------------------------
  it('a SIGKILLed worker loses its lease and another reclaims only the abandoned work', async () => {
    const runId = 'MP_CRASH';
    const taskIds = Array.from({ length: 60 }, (_, i) => `K${i}`);
    const now = new Date().toISOString();
    // A bounded concurrency ceiling makes the run long enough that the crash
    // lands genuinely mid-flight rather than after everything has finished.
    stores.runs.save({
      id: runId, goal: 'crash', state: 'PLANNING', createdAt: now,
      budget: { maxAgents: 4 },
      taskGraph: {
        tasks: taskIds.map((id) => ({
          id, runId, name: id, description: '', agentDefinitionId: 'mpw',
          state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    });

    const crashEnv = { TASK_MS: '400', LEASE_MS: '1500' };

    // The victim gets the run to ITSELF first. With competing workers present
    // from the start, the survivors could claim everything before the victim
    // won a single task, and the test would assert against a crash that never
    // touched any work.
    startWorker([runId], { ...crashEnv, DIE_AFTER_EXEC_STARTS: '2', WORKER_TAG: 'victim' });
    await waitForWorkerBoots(1);
    expect(stores.runs.compareAndSetState(runId, ['PLANNING'], 'CREATED')).toBe(true);

    // It SIGKILLs itself on its second execution, so it always dies holding
    // live claims. Wait for that to actually happen before anyone else arrives.
    await waitForLog(
      (events) => events.filter((e) => e.ev === 'exec_start' && e.tag === 'victim').length >= 2,
      'the victim to start its second execution and die'
    );

    startWorker([runId], { ...crashEnv, WORKER_TAG: 'survivor-1' });
    startWorker([runId], { ...crashEnv, WORKER_TAG: 'survivor-2' });
    await waitForWorkerBoots(3);

    const states = await waitForTerminal([runId], 90_000);
    const events = readLog();
    const execs = executions(events);

    // PIDs come from the workers themselves: `tsx` re-execs, so the pid spawn()
    // returns is a wrapper, not the worker.
    const victimExecs = execs.filter((e) => e.tag === 'victim');
    const survivorExecs = execs.filter((e) => e.tag !== 'victim');
    const victimPid = victimExecs[0]?.pid;
    const survivorPids = [...new Set(survivorExecs.map((e) => e.pid))];

    // The victim really did work before dying, on its own PID.
    expect(victimExecs.length, 'victim executed nothing before dying').toBeGreaterThan(0);
    expect(victimPid).toBeGreaterThan(0);
    expect(survivorPids.length).toBeGreaterThan(0);
    expect(survivorPids).not.toContain(victimPid);

    // MANDATORY: nothing ever ran twice at the same time, crash included.
    const crashClashes = simultaneousDuplicates(execs);
    expect(crashClashes, JSON.stringify(crashClashes.slice(0, 2), null, 2)).toHaveLength(0);

    const persisted = stores.tasks.listByRun(runId);
    expect(persisted).toHaveLength(taskIds.length);
    expect(persisted.every((t) => t.state === 'SUCCEEDED')).toBe(true);
    expect(states[runId]).toBe('COMPLETED');
    expect(persisted.every((t) => t.ownerId === undefined)).toBe(true);

    // Work the victim COMPLETED before dying was not repeated.
    const victimCompleted = new Set(
      events.filter((e) => e.ev === 'exec_end' && e.tag === 'victim').map((e) => `${e.runId}|${e.taskId}`)
    );
    for (const key of victimCompleted) {
      expect(execs.filter((e) => e.key === key), `${key} was re-executed after completing`).toHaveLength(1);
    }

    // Work the victim ABANDONED (started, never finished) was reclaimed by a
    // different process, with a strictly higher attempt.
    const victimStarted = events.filter((e) => e.ev === 'exec_start' && e.tag === 'victim');
    const abandoned = victimStarted.filter((e) => !victimCompleted.has(`${e.runId}|${e.taskId}`));

    // Guard: if the victim had nothing in flight when it died, this test would
    // pass without ever exercising reclaim. Fail loudly instead.
    expect(abandoned.length, 'victim died with no work in flight -- reclaim was never exercised')
      .toBeGreaterThan(0);
    for (const a of abandoned) {
      const key = `${a.runId}|${a.taskId}`;
      const all = execs.filter((e) => e.key === key).sort((x, y) => x.start - y.start);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const reclaim = all[all.length - 1];
      expect(reclaim.tag, `${key} should have been reclaimed by another worker`).not.toBe('victim');
      expect(reclaim.pid, `${key} should have been reclaimed by another PROCESS`).not.toBe(victimPid);
      expect(reclaim.attempt).toBeGreaterThan(all[0].attempt);
      // Attempt counters never decrease.
      for (let i = 1; i < all.length; i++) expect(all[i].attempt).toBeGreaterThan(all[i - 1].attempt);
      // The canonical output came from the reclaiming worker, not the dead one.
      const task = stores.tasks.get({ runId, taskId: a.taskId! })!;
      expect((task.output as { pid: number }).pid).toBe(reclaim.pid);

      // And the reclaim waited for the lease to lapse -- it was not a steal.
      // LEASE_MS is 1500 for this scenario.
      expect(reclaim.start - all[0].start,
        `${key} was reclaimed before its lease expired`).toBeGreaterThanOrEqual(1_500);
    }
  }, 120_000);
});
