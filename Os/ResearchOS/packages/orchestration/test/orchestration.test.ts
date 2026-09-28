/**
 * The worker loop, budget enforcement and the run lifecycle.
 *
 * The claim this suite exists to substantiate is resumability: a research run
 * whose worker dies mid-task must be continuable by a different worker with no
 * loss beyond that one task. That is asserted here by actually killing a worker
 * mid-run and starting another against the same database.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ResearchBudget, type Task, type TaskOutcome } from "@research-os/contracts";
import { InMemoryEventBus, RecordingEventBus } from "@research-os/events";
import { createMemoryLogger, silentLogger } from "@research-os/observability";
import { createStore, migrate, SqliteDatabase, type Database, type ResearchStore } from "@research-os/persistence";
import { TestClock, err, newId } from "@research-os/shared";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import { FIXTURE_NOW as NOW, makeProject, makeTask } from "../../../tests/support/fixtures.ts";
import {
  RunCoordinator, TaskHandlerRegistry, Worker, backoffFor, canTransition, checkBudget, shouldWindDown,
} from "../src/index.ts";

const usage = (overrides: Record<string, number> = {}) => ({
  modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
  tasksCreated: 0, sourcesDiscovered: 0, elapsedMs: 0, ...overrides,
});

describe("budget", () => {
  const budget = ResearchBudget.parse({ maxTokens: 1000, maxCostUsd: 10, maxModelCalls: 50 });

  test("a run inside every ceiling is within budget", () => {
    const verdict = checkBudget(budget, usage({ inputTokens: 100, costUsd: 1 }));
    assert.equal(verdict.withinBudget, true);
    assert.ok(verdict.pressure > 0 && verdict.pressure < 1);
  });

  test("every exceeded ceiling is reported, not just the first", () => {
    const verdict = checkBudget(budget, usage({ inputTokens: 900, outputTokens: 200, costUsd: 12 }));
    assert.equal(verdict.withinBudget, false);
    assert.deepEqual(verdict.exceeded.map((entry) => entry.dimension).sort(), ["maxCostUsd", "maxTokens"]);
    assert.match(verdict.summary, /maxTokens/);
    assert.match(verdict.summary, /maxCostUsd/);
  });

  test("pressure tracks the tightest ceiling", () => {
    assert.equal(checkBudget(budget, usage({ costUsd: 5 })).pressure, 0.5);
    assert.equal(checkBudget(budget, usage({ inputTokens: 1000 })).pressure, 1);
  });

  test("wind-down starts before the budget is spent, so a run has something to show", () => {
    assert.equal(shouldWindDown(checkBudget(budget, usage({ costUsd: 5 }))), false);
    assert.equal(shouldWindDown(checkBudget(budget, usage({ costUsd: 9 }))), true);
  });

  test("backoff grows and is capped", () => {
    assert.equal(backoffFor(1), 2000);
    assert.equal(backoffFor(3), 8000);
    assert.equal(backoffFor(50), 300_000);
  });
});

describe("run lifecycle transitions", () => {
  test("a completed run is terminal", () => {
    assert.equal(canTransition("completed", "running"), false, "reviving a finished run would rewrite history");
    assert.equal(canTransition("failed", "running"), false);
    assert.equal(canTransition("cancelled", "running"), false);
  });

  test("the ordinary path is permitted", () => {
    assert.equal(canTransition("draft", "planning"), true);
    assert.equal(canTransition("planning", "running"), true);
    assert.equal(canTransition("running", "completed"), true);
    assert.equal(canTransition("paused", "running"), true);
  });

  test("a run cannot skip from draft straight to completed", () => {
    assert.equal(canTransition("draft", "completed"), false);
  });
});

describe("Worker", () => {
  let db: Database;
  let store: ResearchStore;
  let projectId: string;
  let clock: TestClock;

  before(async () => {
    db = new SqliteDatabase({ file: ":memory:" });
    await migrate(db);
    store = createStore(db, () => NOW);
  });

  after(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    const project = makeProject({ status: "running" });
    await store.projects.create(project);
    projectId = project.id;
    clock = new TestClock(Date.parse(NOW));
  });

  const worker = (handlers: TaskHandlerRegistry, overrides: Record<string, unknown> = {}) =>
    new Worker({ store, handlers, logger: silentLogger, clock, workerId: "worker-a", ...overrides });

  const handlerFor = (type: Task["type"], handle: () => Promise<TaskOutcome> | TaskOutcome) =>
    new TaskHandlerRegistry().register({ type, handle: async () => handle() });

  /** A store whose first call in every tick fails, standing in for a database outage. */
  const brokenStore = (): ResearchStore =>
    ({
      ...store,
      tasks: {
        ...store.tasks,
        reclaimExpiredLeases: async () => { throw new Error("database unavailable"); },
      },
    }) as unknown as ResearchStore;

  test("a task is claimed, handled and completed", async () => {
    await store.tasks.create([makeTask(projectId, { type: "source.discover" })]);
    const handlers = handlerFor("source.discover", () => ({ kind: "completed", output: { found: 3 }, followUps: [] }));

    const result = await worker(handlers).tick(projectId);

    assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0, parked: 0, budgetStopped: false });
    const counts = await store.tasks.countByStatus(projectId);
    assert.equal(counts["completed"], 1);
  });

  test("follow-up tasks and the completion commit together", async () => {
    const task = makeTask(projectId, { type: "plan.create" });
    await store.tasks.create([task]);
    const followUp = makeTask(projectId, { type: "source.discover" });
    const handlers = handlerFor("plan.create", () => ({ kind: "completed", output: null, followUps: [followUp] }));

    await worker(handlers).tick(projectId);

    const counts = await store.tasks.countByStatus(projectId);
    assert.equal(counts["completed"], 1);
    assert.equal(counts["pending"], 1, "a crash between the two would leave a run that stops for no visible reason");
  });

  test("a task with no registered handler fails without burning retries", async () => {
    const task = makeTask(projectId, { type: "debate.run", maxAttempts: 3 });
    await store.tasks.create([task]);

    const result = await worker(new TaskHandlerRegistry()).tick(projectId);

    assert.equal(result.failed, 1);
    const loaded = await store.tasks.findById(task.id);
    assert.equal(loaded?.status, "failed");
    assert.equal(loaded?.errorCode, "not_implemented", "waiting never registers a handler that was never built");
  });

  test("a handler throwing a classified error is retried", async () => {
    const task = makeTask(projectId, { type: "source.discover", maxAttempts: 3 });
    await store.tasks.create([task]);
    const handlers = handlerFor("source.discover", () => {
      throw err.provider("429 rate limited", { retryable: true });
    });

    await worker(handlers).tick(projectId);

    const loaded = await store.tasks.findById(task.id);
    assert.equal(loaded?.status, "pending", "a retryable failure goes back to the queue");
    assert.equal(loaded?.attempts, 1);
  });

  test("an unrecognised throw is terminal, which is the safe default", async () => {
    // A bare Error carries no retryability information. Guessing that it is
    // transient would burn every attempt reaching the same answer; treating it
    // as permanent stops immediately and surfaces the bug.
    const task = makeTask(projectId, { type: "source.discover", maxAttempts: 3 });
    await store.tasks.create([task]);
    const handlers = handlerFor("source.discover", () => {
      throw new TypeError("cannot read property of undefined");
    });

    await worker(handlers).tick(projectId);

    const loaded = await store.tasks.findById(task.id);
    assert.equal(loaded?.status, "failed");
    assert.equal(loaded?.errorCode, "internal_error");
    assert.match(String(loaded?.errorMessage), /cannot read property/);
  });

  test("a handler returning waiting_for_tool parks the task and releases the lease", async () => {
    const task = makeTask(projectId, { type: "executor.request" });
    await store.tasks.create([task]);
    const requestId = newId("executorRequest");
    const handlers = handlerFor("executor.request", () => ({ kind: "waiting_for_tool", requestId, timeoutMs: 30_000 }));

    const result = await worker(handlers).tick(projectId);

    assert.equal(result.parked, 1);
    const loaded = await store.tasks.findById(task.id);
    assert.equal(loaded?.status, "waiting_for_tool");
    assert.equal(loaded?.leasedBy, null, "a parked task must not hold a worker slot");
    assert.equal((await store.tasks.findByAwaitingRequest(requestId))?.id, task.id);
  });

  test("independent tasks in a batch run concurrently", async () => {
    await store.tasks.create([
      makeTask(projectId, { type: "source.discover" }),
      makeTask(projectId, { type: "source.discover" }),
      makeTask(projectId, { type: "source.discover" }),
    ]);
    let inFlight = 0;
    let peak = 0;
    const handlers = handlerFor("source.discover", async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return { kind: "completed", output: null, followUps: [] };
    });

    const result = await worker(handlers, { batchSize: 3 }).tick(projectId);

    assert.equal(result.completed, 3);
    assert.ok(peak > 1, "the claim query only returns tasks whose dependencies are done, so they are safe to run together");
  });

  test("a dependent task waits for its dependency", async () => {
    const upstream = makeTask(projectId, { type: "source.ingest" });
    const downstream = makeTask(projectId, { type: "evidence.extract", dependsOn: [upstream.id] });
    await store.tasks.create([upstream, downstream]);

    const handlers = new TaskHandlerRegistry()
      .register({ type: "source.ingest", handle: async () => ({ kind: "completed", output: null, followUps: [] }) })
      .register({ type: "evidence.extract", handle: async () => ({ kind: "completed", output: null, followUps: [] }) });
    const running = worker(handlers);

    assert.equal((await running.tick(projectId)).claimed, 1, "only the upstream task is runnable");
    assert.equal((await running.tick(projectId)).claimed, 1, "completing it unblocks the dependent one");
    assert.equal((await store.tasks.countByStatus(projectId))["completed"], 2);
  });

  test("a run that hits a ceiling stops, cancels outstanding work and says which ceiling", async () => {
    const tight = makeProject({ status: "running", budget: { maxTasks: 1 } });
    await store.projects.create(tight);
    await store.tasks.create([
      makeTask(tight.id, { type: "source.discover" }),
      makeTask(tight.id, { type: "source.discover" }),
    ]);

    const bus = new RecordingEventBus();
    const handlers = handlerFor("source.discover", () => ({ kind: "completed", output: null, followUps: [] }));
    const result = await worker(handlers, { bus }).tick(tight.id);

    assert.equal(result.budgetStopped, true);
    assert.equal(result.claimed, 0, "no further work is dispatched once a ceiling is reached");

    const project = await store.projects.findById(tight.id);
    assert.equal(project?.status, "failed");
    assert.match(String(project?.failureReason), /Budget exhausted.*maxTasks/);
    assert.equal((await store.tasks.countByStatus(tight.id))["cancelled"], 2);
    assert.ok(bus.events.some((event) => event.type === "research.failed"), "a stopped run must announce itself");
  });

  /*
   * The behaviour that made a live run look like a hang.
   *
   * A task may only be claimed when every dependency is `completed`. A task
   * that FAILED is therefore not a dependency that will ever be satisfied, and
   * everything behind it becomes permanently unclaimable — pending forever,
   * with the project left in `running` and nothing emitted to say why.
   *
   * This is asserted rather than fixed: whether a stranded run should reach a
   * terminal state, or generate a partial report labelled as partial, is a
   * design decision about research integrity. What must not happen again is
   * that the behaviour is undocumented and discovered in production.
   */
  test("a failed dependency permanently strands every task behind it", async () => {
    const doomed = makeTask(projectId, { type: "source.discover" });
    const dependent = makeTask(projectId, { type: "evidence.extract", dependsOn: [doomed.id] });
    const behindThat = makeTask(projectId, { type: "report.generate", dependsOn: [dependent.id] });
    await store.tasks.create([doomed, dependent, behindThat]);

    const executed: string[] = [];
    const handlers = new TaskHandlerRegistry()
      .register({
        type: "source.discover",
        handle: async () => {
          executed.push("source.discover");
          // Exactly the shape `blocked()` produces for a missing capability.
          return { kind: "failed", errorCode: "unsupported", errorMessage: "BLOCKED: no search tool", retryable: false };
        },
      })
      .register({ type: "evidence.extract", handle: async () => { executed.push("evidence.extract"); return { kind: "completed", output: {}, followUps: [] }; } })
      .register({ type: "report.generate", handle: async () => { executed.push("report.generate"); return { kind: "completed", output: {}, followUps: [] }; } });

    const w = worker(handlers);
    for (let i = 0; i < 5; i++) await w.tick(projectId);

    assert.deepEqual(executed, ["source.discover"], "nothing behind the failed task ever ran");
    const counts = await store.tasks.countByStatus(projectId);
    assert.equal(counts["failed"], 1);
    assert.equal(counts["pending"], 2, "both dependents are stranded, not failed and not cancelled");

    assert.equal(
      await store.tasks.hasRunnableWork(projectId), true,
      "the queue still reports runnable work, which is why a stranded run idles in `running` rather than settling",
    );
    assert.equal((await store.tasks.claim({ workerId: "w", projectId, max: 10, leaseMs: 1000, now: NOW })).length, 0,
      "…yet nothing can actually be claimed: that contradiction is the defect");
  });

  test("a failing tick propagates rather than being swallowed", async () => {
    const broken = brokenStore();
    const failing = new Worker({ store: broken, handlers: new TaskHandlerRegistry(), logger: silentLogger, clock });

    await assert.rejects(failing.tick(projectId), /database unavailable/, "tick is the deterministic surface; it reports faults");
  });

  test("the run loop survives a failing tick, logs it and backs off", async () => {
    const logger = createMemoryLogger();
    // A real clock with a tiny backoff: the loop's sleep has to actually elapse
    // for the test to be meaningful, and a TestClock whose sleep returns
    // instantly would spin as fast as the event loop allows.
    const failing = new Worker({
      store: brokenStore(),
      handlers: new TaskHandlerRegistry(),
      logger: logger.logger,
      backoffMs: 5,
      maxBackoffMs: 10,
    });

    const loop = failing.run(projectId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    failing.stop();
    await loop;

    const errors = logger.lines.filter((line) => line["level"] === "error" && /Worker tick failed/.test(String(line["message"])));
    assert.ok(errors.length > 0, "a transient database fault must not take the whole run with it");
    assert.ok(errors.length < 500, "and it must back off rather than spin");
    assert.equal(failing.isRunning, false);
  });
});

describe("resumability", () => {
  let db: Database;
  let store: ResearchStore;

  before(async () => {
    db = new SqliteDatabase({ file: ":memory:" });
    await migrate(db);
    store = createStore(db, () => NOW);
  });

  after(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  test("a worker that dies mid-task loses only that task, and another finishes the run", async () => {
    const project = makeProject({ status: "running" });
    await store.projects.create(project);
    const clock = new TestClock(Date.parse(NOW));

    const tasks = [
      makeTask(project.id, { type: "source.discover", priority: 90 }),
      makeTask(project.id, { type: "source.ingest", priority: 50 }),
      makeTask(project.id, { type: "evidence.extract", priority: 10 }),
    ];
    await store.tasks.create(tasks);

    // Worker A claims the highest-priority task and then "dies": the promise is
    // abandoned, the lease is left dangling, and nothing is written.
    const doomed = new Worker({
      store,
      handlers: new TaskHandlerRegistry().register({
        type: "source.discover",
        handle: () => new Promise<TaskOutcome>(() => { /* never settles — the process is gone */ }),
      }),
      logger: silentLogger,
      clock,
      workerId: "worker-doomed",
      batchSize: 1,
      defaultLeaseMs: 30_000,
    });
    void doomed.tick(project.id);
    await new Promise((resolve) => setImmediate(resolve));

    const midRun = await store.tasks.findById(tasks[0]!.id);
    assert.equal(midRun?.status, "running", "the task is leased and in flight");
    assert.ok(midRun?.leasedBy?.startsWith("worker-doomed"));

    // Time passes; the lease lapses. A fresh worker picks up exactly where the
    // dead one left off, with no coordination between them beyond the database.
    clock.advance(60_000);

    const completedTypes: string[] = [];
    const survivor = new Worker({
      store,
      handlers: new TaskHandlerRegistry().registerAll(
        (["source.discover", "source.ingest", "evidence.extract"] as const).map((type) => ({
          type,
          handle: async () => {
            completedTypes.push(type);
            return { kind: "completed" as const, output: null, followUps: [] };
          },
        })),
      ),
      logger: silentLogger,
      clock,
      workerId: "worker-b",
      batchSize: 5,
    });

    for (let tick = 0; tick < 5; tick++) await survivor.tick(project.id);

    assert.deepEqual(completedTypes.sort(), ["evidence.extract", "source.discover", "source.ingest"]);
    assert.equal((await store.tasks.countByStatus(project.id))["completed"], 3, "no work was lost and none was done twice");
  });

  test("resume reclaims abandoned leases and puts a paused run back to work", async () => {
    const project = makeProject({ status: "paused" });
    await store.projects.create(project);
    const clock = new TestClock(Date.parse(NOW));
    const coordinator = new RunCoordinator({ store, logger: silentLogger, clock, bus: new InMemoryEventBus() });

    const task = makeTask(project.id, { type: "source.discover" });
    await store.tasks.create([task]);
    await store.tasks.claim({ workerId: "gone", projectId: project.id, max: 1, leaseMs: 1000, now: clock.isoNow() });
    clock.advance(30_000);

    const result = await coordinator.resume(project.id);

    assert.equal(result.resumed, true);
    assert.equal(result.requeued, 1, "the dead worker's lease is reclaimed");
    assert.equal((await store.projects.findById(project.id))?.status, "running");
  });

  test("resuming a completed project is refused with a reason", async () => {
    const project = makeProject({ status: "completed" });
    await store.projects.create(project);
    const coordinator = new RunCoordinator({ store, logger: silentLogger });

    const result = await coordinator.resume(project.id);
    assert.equal(result.resumed, false);
    assert.match(String(result.reason), /completed/);
  });

  test("a run with no runnable work left settles as completed", async () => {
    const project = makeProject({ status: "running" });
    await store.projects.create(project);
    const bus = new RecordingEventBus();
    const coordinator = new RunCoordinator({ store, logger: silentLogger, bus });

    const task = makeTask(project.id, { type: "source.discover" });
    await store.tasks.create([task]);
    assert.equal(await coordinator.settleIfFinished(project.id), null, "work remains");

    await store.tasks.complete(task.id, {}, NOW);
    assert.equal(await coordinator.settleIfFinished(project.id), "completed");
    assert.ok(bus.events.some((event) => event.type === "research.completed"));
  });

  test("a run where everything failed settles as failed, not as a thin success", async () => {
    const project = makeProject({ status: "running" });
    await store.projects.create(project);
    const coordinator = new RunCoordinator({ store, logger: silentLogger });

    const task = makeTask(project.id, { type: "source.discover", maxAttempts: 1 });
    await store.tasks.create([task]);
    await store.tasks.fail(task.id, { code: "provider_error", message: "no", retryable: false }, 0, NOW);

    assert.equal(await coordinator.settleIfFinished(project.id), "failed");
  });

  test("a run that completed with some failures still completes", async () => {
    const project = makeProject({ status: "running" });
    await store.projects.create(project);
    const coordinator = new RunCoordinator({ store, logger: silentLogger });

    const good = makeTask(project.id, { type: "source.discover" });
    const bad = makeTask(project.id, { type: "source.ingest", maxAttempts: 1 });
    await store.tasks.create([good, bad]);
    await store.tasks.complete(good.id, {}, NOW);
    await store.tasks.fail(bad.id, { code: "provider_error", message: "no", retryable: false }, 0, NOW);

    assert.equal(
      await coordinator.settleIfFinished(project.id),
      "completed",
      "forcing this to failed would discard findings that are perfectly good",
    );
  });

  test("an illegal transition is refused", async () => {
    const project = makeProject({ status: "completed" });
    await store.projects.create(project);
    const coordinator = new RunCoordinator({ store, logger: silentLogger });

    await assert.rejects(coordinator.transition(project.id, "running"), /cannot move from/);
  });

  test("progress reports aggregate counts without extra round trips", async () => {
    const project = makeProject({ status: "running" });
    await store.projects.create(project);
    const coordinator = new RunCoordinator({ store, logger: silentLogger });

    await store.tasks.create([makeTask(project.id, { type: "source.discover" })]);
    const progress = await coordinator.progress(project.id);

    assert.equal(progress.tasksTotal, 1);
    assert.equal(progress.tasksCompleted, 0);
    assert.equal(progress.claimsCount, 0);
    assert.ok(progress.elapsedMs >= 0);
  });
});
