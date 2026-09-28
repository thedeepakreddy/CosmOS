/**
 * The external executor protocol.
 *
 * This is the boundary a host application attaches through, so the tests that
 * matter are the ones about trust: a token must not be recoverable from the
 * database, an executor must not answer a request it did not claim, and a
 * vanished executor must not leave research waiting forever.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ToolDescriptor, ToolPermissionPolicy } from "@research-os/contracts";
import { createStore, migrate, SqliteDatabase, type Database, type ResearchStore } from "@research-os/persistence";
import { LocalToolProvider, ToolRegistry } from "@research-os/tools";
import { TestClock, type ResearchError } from "@research-os/shared";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import { FIXTURE_NOW as NOW, makeProject } from "../../../tests/support/fixtures.ts";
import { ExecutorService, ExecutorToolProvider, hashToken } from "../src/index.ts";

const browserTool = ToolDescriptor.parse({
  id: "browser_open", name: "Open a page in a browser",
  description: "Drives a real browser in the host application's environment.",
  capability: "browser", riskLevel: "side_effecting",
  inputSchema: { type: "object", properties: { url: { type: "string" } } },
  provider: "executor",
});

const registration = (overrides: Record<string, unknown> = {}) => ({
  name: "workstation-1", capabilities: ["browser", "filesystem_read"], mode: "pull", ...overrides,
});

describe("ExecutorService", () => {
  let db: Database;
  let store: ResearchStore;
  let service: ExecutorService;
  let clock: TestClock;
  let projectId: string;

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
    const project = makeProject();
    await store.projects.create(project);
    projectId = project.id;
    clock = new TestClock(Date.parse(NOW));
    service = new ExecutorService({ repository: store.executors, clock });
  });

  test("registration returns a token, and only its hash is stored", async () => {
    const { executor, token } = await service.register(registration());

    assert.match(token, /^exk_/);
    assert.deepEqual(executor.capabilities, ["browser", "filesystem_read"]);

    const rows = await db.query<{ token_hash: string }>("SELECT token_hash FROM executors");
    assert.equal(rows[0]?.token_hash, hashToken(token));
    assert.ok(!rows[0]?.token_hash.includes(token), "a token readable from the database is a credential the database must be trusted with");
  });

  test("a valid token authenticates and an invalid one does not", async () => {
    const { executor, token } = await service.register(registration());

    assert.equal((await service.authenticate(token))?.id, executor.id);
    assert.equal(await service.authenticate("exk_wrong"), undefined);
    assert.equal(await service.authenticate(""), undefined);
  });

  test("re-registering the same name keeps the identity and issues a fresh token", async () => {
    const first = await service.register(registration());
    const second = await service.register(registration({ version: "2.0" }));

    assert.equal(second.executor.id, first.executor.id, "an executor that restarted is the same executor");
    assert.notEqual(second.token, first.token);
    assert.equal(await service.authenticate(first.token), undefined, "the old token stops working");
    assert.ok(await service.authenticate(second.token));
  });

  test("an executor that has not checked in is not a place to send work", async () => {
    await service.register(registration());
    assert.equal((await service.healthyExecutorsFor("browser")).length, 1);

    clock.advance(200_000);
    assert.equal((await service.healthyExecutorsFor("browser")).length, 0, "silence is not health");
  });

  test("a heartbeat brings an executor back into rotation", async () => {
    const { executor } = await service.register(registration());
    clock.advance(200_000);
    assert.equal((await service.healthyExecutorsFor("browser")).length, 0);

    await service.heartbeat(executor.id, "healthy");
    assert.equal((await service.healthyExecutorsFor("browser")).length, 1);
  });

  test("requesting a capability nobody advertises fails with a retryable error", async () => {
    await service.register(registration({ capabilities: ["browser"] }));

    await assert.rejects(
      service.requestCapability({ projectId, capability: "python", toolId: "run_python", payload: {} }),
      (error: ResearchError) => error.code === "executor_unavailable" && error.retryable === true,
    );
  });

  test("a request is claimed by capability, not by name", async () => {
    const { executor } = await service.register(registration());
    const request = await service.requestCapability({ projectId, capability: "browser", toolId: "browser_open", payload: { url: "https://example.org" } });

    const claimed = await service.claimWork(executor.id, ["browser"]);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, request.id);

    const second = await service.claimWork(executor.id, ["browser"]);
    assert.equal(second.length, 0, "a claimed request must not be handed out twice");
  });

  test("an executor cannot claim work for a capability it does not advertise", async () => {
    const { executor } = await service.register(registration({ capabilities: ["browser"] }));
    await service.requestCapability({ projectId, capability: "browser", toolId: "browser_open", payload: {} });

    assert.equal((await service.claimWork(executor.id, ["filesystem_read"])).length, 0);
  });

  test("a result is validated before it touches research state", async () => {
    const { executor } = await service.register(registration());
    const request = await service.requestCapability({ projectId, capability: "browser", toolId: "browser_open", payload: {} });
    await service.claimWork(executor.id, ["browser"]);

    await assert.rejects(
      service.submitResult(request.id, executor.id, { status: "succeeded but not really" }),
      "an executor runs outside this process and is untrusted input",
    );
    await assert.rejects(service.submitResult(request.id, executor.id, { status: "failed" }), "a failure must carry a message");

    const completed = await service.submitResult(request.id, executor.id, { status: "succeeded", output: { title: "Example" } });
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.output, { title: "Example" });
  });

  test("one executor cannot answer another executor's request", async () => {
    const first = await service.register(registration({ name: "worker-a" }));
    const second = await service.register(registration({ name: "worker-b" }));
    const request = await service.requestCapability({ projectId, capability: "browser", toolId: "browser_open", payload: {} });
    await service.claimWork(first.executor.id, ["browser"]);

    await assert.rejects(
      service.submitResult(request.id, second.executor.id, { status: "succeeded", output: {} }),
      (error: ResearchError) => error.code === "forbidden",
      "otherwise any executor could inject output into research it was never asked to contribute to",
    );
  });

  test("a completed request cannot be answered twice", async () => {
    const { executor } = await service.register(registration());
    const request = await service.requestCapability({ projectId, capability: "browser", toolId: "browser_open", payload: {} });
    await service.claimWork(executor.id, ["browser"]);
    await service.submitResult(request.id, executor.id, { status: "succeeded", output: 1 });

    await assert.rejects(
      service.submitResult(request.id, executor.id, { status: "succeeded", output: 2 }),
      (error: ResearchError) => error.code === "conflict",
    );
  });

  test("a vanished executor does not leave research waiting forever", async () => {
    const { executor } = await service.register(registration());
    const request = await service.requestCapability({ projectId, capability: "browser", toolId: "browser_open", payload: {}, timeoutMs: 1000 });
    await service.claimWork(executor.id, ["browser"]);

    assert.deepEqual(await service.expireStale(), []);

    clock.advance(5000);
    const expired = await service.expireStale();
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.id, request.id);
    assert.equal((await service.findRequest(request.id))?.status, "timed_out");
  });
});

describe("ExecutorToolProvider", () => {
  let db: Database;
  let store: ResearchStore;
  let service: ExecutorService;
  let clock: TestClock;
  let projectId: string;

  const policy = ToolPermissionPolicy.parse({
    allowedToolIds: ["browser_open"], allowedCapabilities: ["browser"], maxRiskLevel: "side_effecting",
  });

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
    const project = makeProject();
    await store.projects.create(project);
    projectId = project.id;
    clock = new TestClock(Date.parse(NOW));
    service = new ExecutorService({ repository: store.executors, clock });
  });

  test("a tool with no executor behind it is not offered at all", async () => {
    const provider = new ExecutorToolProvider({ service, tools: [browserTool], clock });
    const registry = new ToolRegistry({ providers: [provider] });
    await registry.refresh();

    assert.deepEqual(registry.listAll(), [], "offering a tool that will fail the moment it is called is worse than not offering it");

    await service.register(registration());
    await registry.refresh();
    assert.deepEqual(registry.listAll().map((tool) => tool.id), ["browser_open"]);
  });

  /**
   * Plays the host application's side: poll for work and answer it.
   *
   * Bounded by wall-clock rather than by attempt count, because the request does
   * not exist until the tool call creates it — a loop counting attempts can
   * finish before there is anything to claim and the test then fails for a
   * reason that has nothing to do with the protocol.
   */
  const runExecutorUntilAnswered = async (
    executorId: string,
    answer: (requestId: string) => Promise<unknown>,
    timeoutMs = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const claimed = await service.claimWork(executorId, ["browser"]);
      if (claimed[0]) {
        await answer(claimed[0].id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  test("a tool call becomes a capability request an executor fulfils", async () => {
    const { executor } = await service.register(registration());
    // A real clock here: this test is about genuine concurrency between the
    // waiting caller and the answering executor, and the provider's deadline is
    // wall-clock.
    const provider = new ExecutorToolProvider({ service, tools: [browserTool], pollIntervalMs: 2, defaultTimeoutMs: 5000 });
    const registry = new ToolRegistry({ providers: [provider] });
    await registry.refresh();

    const call = registry.call("browser_open", { url: "https://example.org" }, { projectId, policy });
    await runExecutorUntilAnswered(executor.id, (requestId) =>
      service.submitResult(requestId, executor.id, { status: "succeeded", output: { title: "Example Domain" } }),
    );
    const outcome = await call;

    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(outcome.status === "succeeded" ? outcome.output : null, { title: "Example Domain" });
    assert.equal(outcome.provider, "executor", "the call is recorded against the executor that served it");
  });

  test("an executor failure surfaces as a failed tool call, not a hang", async () => {
    const { executor } = await service.register(registration());
    const provider = new ExecutorToolProvider({ service, tools: [browserTool], pollIntervalMs: 2, defaultTimeoutMs: 5000 });
    const registry = new ToolRegistry({ providers: [provider] });
    await registry.refresh();

    const call = registry.call("browser_open", { url: "https://example.org" }, { projectId, policy });
    await runExecutorUntilAnswered(executor.id, (requestId) =>
      service.submitResult(requestId, executor.id, { status: "failed", errorMessage: "The browser crashed." }),
    );
    const outcome = await call;

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /browser crashed/);
  });

  test("an executor that never answers times out rather than hanging", async () => {
    await service.register(registration());
    const provider = new ExecutorToolProvider({ service, tools: [browserTool], pollIntervalMs: 2, defaultTimeoutMs: 120 });
    const registry = new ToolRegistry({ providers: [provider] });
    await registry.refresh();

    const outcome = await registry.call("browser_open", { url: "https://example.org" }, { projectId, policy });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /did not answer|within 120ms/);
  });

  test("the permission policy still applies to executor-backed tools", async () => {
    await service.register(registration());
    const provider = new ExecutorToolProvider({ service, tools: [browserTool], clock });
    const registry = new ToolRegistry({ providers: [provider] });
    await registry.refresh();

    const restricted = ToolPermissionPolicy.parse({ allowedToolIds: ["browser_open"], allowedCapabilities: ["browser"], maxRiskLevel: "read_only" });
    const outcome = await registry.call("browser_open", { url: "https://example.org" }, { projectId, policy: restricted });

    assert.equal(outcome.status, "denied");
    assert.match(outcome.status === "denied" ? outcome.errorMessage : "", /exceeds the policy maximum/);
  });

  test("a local tool is not displaced by an executor claiming the same id", async () => {
    await service.register(registration());
    const registry = new ToolRegistry({
      providers: [new LocalToolProvider([]), new ExecutorToolProvider({ service, tools: [browserTool], clock })],
    });
    await registry.refresh();
    assert.equal(registry.listAll()[0]?.provider, "executor", "with no local implementation, the executor serves it");
  });
});
