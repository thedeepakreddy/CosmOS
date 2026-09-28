/**
 * Persistence tests, run twice: once on SQLite and once on a real PostgreSQL
 * engine (PGlite, Postgres compiled to WASM).
 *
 * Running the identical assertions on both is the only thing that makes the
 * "one schema, two engines" claim meaningful. The dialects differ in placeholder
 * syntax, boolean representation, JSON handling and row locking, and every one
 * of those has been a source of a real bug during development.
 *
 * Each test starts from an empty database. Several assertions here are about
 * totals — "exactly one transferable failure", "nothing is claimable yet" — and
 * those are statements about the whole table, so a row left behind by an earlier
 * test would make them fail for a reason that has nothing to do with the code
 * under test.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  createStore, migrate, SqliteDatabase, type Database, type ResearchStore,
} from "../src/index.ts";
import { PgliteDatabase } from "../../../tests/support/pglite-database.ts";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import {
  FIXTURE_NOW as NOW, at as later, makeFailure, makeObjective, makeProject, makeSource, makeTask,
} from "../../../tests/support/fixtures.ts";
import { newId } from "@research-os/shared";

const engines: { name: string; create: () => Promise<Database> }[] = [
  { name: "sqlite", create: async () => new SqliteDatabase({ file: ":memory:" }) },
  { name: "postgres (pglite)", create: () => PgliteDatabase.create() },
];

for (const engine of engines) {
  describe(`persistence on ${engine.name}`, () => {
    let db: Database;
    let store: ResearchStore;

    before(async () => {
      db = await engine.create();
      await migrate(db);
      store = createStore(db, () => NOW);
    });

    beforeEach(() => resetDatabase(db));

    after(async () => {
      await db.close();
    });

    test("projects round-trip with JSON columns intact", async () => {
      const project = makeProject();
      await store.projects.create(project);
      const loaded = await store.projects.findById(project.id);
      assert.ok(loaded, "project must be retrievable");
      assert.equal(loaded.title, project.title);
      assert.equal(loaded.tenantId, "acme");
      assert.deepEqual(loaded.preferences, project.preferences);
      assert.equal(loaded.preferences.citationStyle, "apa");
      assert.equal(loaded.preferences.minSourceQuality, 0.3, "schema defaults must survive the round trip too");
      assert.equal(loaded.createdBy?.application, "test-harness");
      assert.equal(loaded.completedAt, null);
    });

    test("a missing row returns undefined rather than throwing", async () => {
      assert.equal(await store.projects.findById(makeProject().id), undefined);
    });

    test("sources are deduplicated by content hash within a project", async () => {
      const project = makeProject();
      await store.projects.create(project);

      const first = await store.research.upsertSource(makeSource(project.id));
      const second = await store.research.upsertSource(makeSource(project.id));

      assert.equal(first.created, true);
      assert.equal(second.created, false, "the same content must not become a second source");
      assert.equal(second.source.id, first.source.id);
      assert.equal((await store.research.listSources(project.id)).length, 1);
    });

    test("boolean columns survive the round trip on both engines", async () => {
      const project = makeProject();
      await store.projects.create(project);
      await store.runs.addFailure(makeFailure(project.id, { transferable: true }));
      const failures = await store.runs.listFailures(project.id);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.transferable, true, "SQLite stores booleans as integers; the mapping must normalise");
    });

    test("a JSON column holding a scalar round-trips on both engines", async () => {
      // A regression test with a specific history. Postgres parses `jsonb` by
      // default, and it returns a JSON *object* as an object but a JSON *string*
      // as a bare string with the quotes already gone — at which point row
      // mapping cannot tell it apart from the JSON text SQLite returns, and
      // `JSON.parse("a plain string")` throws. Every JSON column holding a
      // scalar silently read back as null on Postgres, and correctly on SQLite.
      // Both adapters now return JSON columns as raw text.
      const project = makeProject();
      await store.projects.create(project);

      const scalars: [string, unknown][] = [
        ["a plain string that is not JSON", "source.discover"],
        ["42", "evidence.extract"],
        ["true", "claim.extract"],
        ["{\"looks\": \"like json\"}", "verification.run"],
      ];

      for (const [value, type] of scalars) {
        const task = makeTask(project.id, { type, input: value });
        await store.tasks.create([task]);
        const loaded = await store.tasks.findById(task.id);
        assert.equal(loaded?.input, value, `a JSON column holding ${JSON.stringify(value)} must survive the round trip`);
      }

      const structured = makeTask(project.id, { type: "plan.create", input: { nested: { list: [1, "two", null] } } });
      await store.tasks.create([structured]);
      assert.deepEqual((await store.tasks.findById(structured.id))?.input, { nested: { list: [1, "two", null] } });
    });

    test("transferable failures are visible from other projects", async () => {
      const source = makeProject();
      const other = makeProject();
      await store.projects.create(source);
      await store.projects.create(other);
      await store.runs.addFailure(makeFailure(source.id, {
        kind: "failed_experiment", approach: "Fine-tuning on 200 samples",
        reason: "Severe overfitting", lesson: "Need 10x the data", transferable: true,
      }));
      await store.runs.addFailure(makeFailure(source.id, {
        kind: "broken_pipeline", approach: "Local-only detail",
        reason: "Environment-specific", lesson: null, transferable: false,
      }));

      const transferable = await store.runs.transferableFailures(other.id);
      assert.equal(transferable.length, 1, "only transferable failures cross project boundaries");
      assert.equal(transferable[0]!.approach, "Fine-tuning on 200 samples");
      assert.equal((await store.runs.transferableFailures(source.id)).length, 0, "a project does not read its own failures back as transferable");
    });

    test("transferable failures do not cross a tenant boundary", async () => {
      // A dead end is often a statement about a private dataset or an internal
      // system. One customer's research run must not read another's.
      const acme = makeProject({ tenantId: "acme" });
      const other = makeProject({ tenantId: "globex" });
      const sameTenant = makeProject({ tenantId: "acme" });
      await store.projects.create(acme);
      await store.projects.create(other);
      await store.projects.create(sameTenant);

      await store.runs.addFailure(makeFailure(acme.id, {
        approach: "Acme's internal data lake", reason: "Schema changed without notice", transferable: true,
      }));
      await store.runs.addFailure(makeFailure(other.id, {
        approach: "Globex's private benchmark", reason: "Access revoked", transferable: true,
      }));

      const visible = await store.runs.transferableFailures(sameTenant.id);
      assert.equal(visible.length, 1, "only the same tenant's failures cross a project boundary");
      assert.match(visible[0]!.approach, /Acme/);
      assert.ok(
        !visible.some((failure) => /Globex/.test(failure.approach)),
        "another tenant's dead ends must never be readable",
      );
    });

    test("a project with no tenant sees only other untenanted projects", async () => {
      const untenantedA = makeProject({ tenantId: null });
      const untenantedB = makeProject({ tenantId: null });
      const tenanted = makeProject({ tenantId: "acme" });
      await store.projects.create(untenantedA);
      await store.projects.create(untenantedB);
      await store.projects.create(tenanted);

      await store.runs.addFailure(makeFailure(untenantedA.id, { approach: "Shared local approach", transferable: true }));
      await store.runs.addFailure(makeFailure(tenanted.id, { approach: "Acme approach", transferable: true }));

      const visible = await store.runs.transferableFailures(untenantedB.id);
      assert.equal(visible.length, 1, "NULL tenant matches NULL tenant, and nothing else");
      assert.match(visible[0]!.approach, /Shared local/);
    });

    test("an equivalent failure is detectable, so the same wall is not recorded repeatedly", async () => {
      const project = makeProject();
      await store.projects.create(project);
      await store.runs.addFailure(makeFailure(project.id, {
        kind: "tool_limitation", approach: "  Keyword Search Alone  ",
      }));

      assert.equal(
        await store.runs.hasSimilarFailure(project.id, "tool_limitation", "keyword search alone"),
        true,
        "matching is normalised for case and surrounding whitespace",
      );
      assert.equal(await store.runs.hasSimilarFailure(project.id, "dead_end_approach", "keyword search alone"), false, "a different kind is a different failure");
      assert.equal(await store.runs.hasSimilarFailure(project.id, "tool_limitation", "citation chaining"), false);
    });

    test("event sequences are gapless and strictly increasing per project", async () => {
      const a = makeProject();
      const b = makeProject();
      await store.projects.create(a);
      await store.projects.create(b);

      for (let i = 0; i < 5; i++) {
        await store.events.append({ projectId: a.id, type: "research.source.discovered", payload: { n: i } });
      }
      await store.events.append({ projectId: b.id, type: "research.started", payload: { planVersion: 1 } });

      const events = await store.events.read(a.id);
      assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
      assert.equal(await store.events.lastSequence(a.id), 5);
      assert.equal(await store.events.lastSequence(b.id), 1, "sequences are per project, not global");
    });

    test("events can be replayed from a resume point", async () => {
      const project = makeProject();
      await store.projects.create(project);
      for (let i = 0; i < 6; i++) {
        await store.events.append({ projectId: project.id, type: "research.claim.created", payload: { n: i } });
      }
      const resumed = await store.events.read(project.id, { since: 3 });
      assert.deepEqual(resumed.map((event) => event.sequence), [4, 5, 6], "resume is exclusive of the given sequence");
    });

    test("a transaction rolls back completely on failure", async () => {
      const project = makeProject();
      await store.projects.create(project);
      const before = (await store.projects.listObjectives(project.id)).length;

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.projects.addObjectives([makeObjective(project.id)]);
          throw new Error("deliberate failure after a successful write");
        }),
      );

      assert.equal((await store.projects.listObjectives(project.id)).length, before, "the write inside the failed transaction must not persist");
    });
  });

  describe(`task queue on ${engine.name}`, () => {
    let db: Database;
    let store: ResearchStore;
    let projectId: string;

    before(async () => {
      db = await engine.create();
      await migrate(db);
      store = createStore(db, () => NOW);
    });

    beforeEach(async () => {
      await resetDatabase(db);
      const project = makeProject();
      await store.projects.create(project);
      projectId = project.id;
    });

    after(async () => {
      await db.close();
    });

    test("claiming leases a task exactly once", async () => {
      const task = makeTask(projectId);
      await store.tasks.create([task]);

      const first = await store.tasks.claim({ workerId: "worker-a", projectId, max: 5, leaseMs: 30_000, now: NOW });
      const second = await store.tasks.claim({ workerId: "worker-b", projectId, max: 5, leaseMs: 30_000, now: NOW });

      assert.equal(first.length, 1, "the first worker gets the task");
      assert.equal(second.length, 0, "a second worker must not get the same task");
      assert.equal(first[0]!.status, "running");
      assert.equal(first[0]!.attempts, 1, "claiming counts as an attempt");
      assert.ok(first[0]!.leasedBy?.startsWith("worker-a#"));
    });

    test("a task is not claimable until its dependencies complete", async () => {
      const upstream = makeTask(projectId, { type: "source.ingest" });
      const downstream = makeTask(projectId, { type: "evidence.extract", dependsOn: [upstream.id] });
      await store.tasks.create([upstream, downstream]);

      const firstPass = await store.tasks.claim({ workerId: "w", projectId, max: 10, leaseMs: 30_000, now: NOW });
      assert.ok(firstPass.some((task) => task.id === upstream.id), "the upstream task is runnable");
      assert.ok(!firstPass.some((task) => task.id === downstream.id), "the dependent task must be blocked");

      await store.tasks.complete(upstream.id, { ok: true }, NOW);

      const secondPass = await store.tasks.claim({ workerId: "w", projectId, max: 10, leaseMs: 30_000, now: NOW });
      assert.ok(secondPass.some((task) => task.id === downstream.id), "completing the dependency unblocks it");
    });

    test("higher priority is claimed first", async () => {
      const low = makeTask(projectId, { priority: 10, type: "report.generate" });
      const high = makeTask(projectId, { priority: 90, type: "plan.create" });
      await store.tasks.create([low, high]);

      const claimed = await store.tasks.claim({ workerId: "w", projectId, max: 1, leaseMs: 30_000, now: NOW });
      assert.equal(claimed[0]!.id, high.id, "priority must order the queue");
    });

    test("an expired lease returns the task to the pool — this is crash recovery", async () => {
      const task = makeTask(projectId, { type: "claim.extract" });
      await store.tasks.create([task]);
      await store.tasks.claim({ workerId: "doomed-worker", projectId, max: 1, leaseMs: 1000, now: NOW });

      // Nothing is claimable while the lease is live.
      assert.equal((await store.tasks.claim({ workerId: "other", projectId, max: 5, leaseMs: 1000, now: NOW })).length, 0);

      const afterExpiry = later(5000);
      const reclaimed = await store.tasks.reclaimExpiredLeases(afterExpiry);
      assert.equal(reclaimed.requeued, 1, "the abandoned task must be requeued");

      const reclaimedTasks = await store.tasks.claim({ workerId: "other", projectId, max: 5, leaseMs: 30_000, now: afterExpiry });
      assert.ok(reclaimedTasks.some((candidate) => candidate.id === task.id), "another worker can now pick it up");
    });

    test("a task that exhausts its attempts fails rather than looping", async () => {
      const task = makeTask(projectId, { type: "verification.run", maxAttempts: 1 });
      await store.tasks.create([task]);
      await store.tasks.claim({ workerId: "w", projectId, max: 1, leaseMs: 1000, now: NOW });

      const result = await store.tasks.reclaimExpiredLeases(later(5000));
      assert.equal(result.failed, 1, "no attempts left means terminal failure, not an infinite retry");
      const loaded = await store.tasks.findById(task.id);
      assert.equal(loaded?.status, "failed");
      assert.equal(loaded?.errorCode, "lease_expired");
    });

    test("a retryable failure reschedules with backoff", async () => {
      const task = makeTask(projectId, { type: "source.discover", maxAttempts: 3 });
      await store.tasks.create([task]);
      await store.tasks.claim({ workerId: "w", projectId, max: 1, leaseMs: 30_000, now: NOW });

      const status = await store.tasks.fail(task.id, { code: "rate_limited", message: "429", retryable: true }, 60_000, NOW);
      assert.equal(status, "pending");

      const loaded = await store.tasks.findById(task.id);
      assert.equal(loaded?.runAfter, later(60_000), "backoff must push run_after into the future");
      assert.equal((await store.tasks.claim({ workerId: "w", projectId, max: 5, leaseMs: 1000, now: NOW })).length, 0, "and it must not be claimable before then");
      assert.equal((await store.tasks.claim({ workerId: "w", projectId, max: 5, leaseMs: 1000, now: later(61_000) })).length, 1, "but claimable after");
    });

    test("a non-retryable failure is terminal even with attempts remaining", async () => {
      const task = makeTask(projectId, { type: "report.generate", maxAttempts: 5 });
      await store.tasks.create([task]);
      await store.tasks.claim({ workerId: "w", projectId, max: 1, leaseMs: 30_000, now: NOW });
      const status = await store.tasks.fail(task.id, { code: "validation_failed", message: "bad input", retryable: false }, 1000, NOW);
      assert.equal(status, "failed");
    });

    test("tasks park and resume around an external tool call", async () => {
      const task = makeTask(projectId, { type: "executor.request" });
      await store.tasks.create([task]);
      await store.tasks.claim({ workerId: "w", projectId, max: 1, leaseMs: 30_000, now: NOW });

      const requestId = newId("executorRequest");
      await store.tasks.waitForTool(task.id, requestId, NOW);

      const parked = await store.tasks.findById(task.id);
      assert.equal(parked?.status, "waiting_for_tool");
      assert.equal(parked?.leasedBy, null, "a parked task must release its lease");
      assert.equal((await store.tasks.findByAwaitingRequest(requestId))?.id, task.id);

      await store.tasks.resume(task.id, NOW);
      assert.equal((await store.tasks.findById(task.id))?.status, "pending");
    });
  });
}
