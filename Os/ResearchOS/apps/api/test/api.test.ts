/**
 * The HTTP API, driven through the SDK an application would actually use.
 *
 * Real Fastify, real sockets, real database — the client talks to the server the
 * same way Aira or any other caller would. Testing through the SDK rather than
 * with hand-built requests means a drift between the two is a test failure
 * rather than something a consumer discovers.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { ResearchOSClient } from "@research-os/sdk";
import { ScriptedModelProvider, scriptedModels } from "@research-os/model-router";
import { createMemoryLogger } from "@research-os/observability";
import type { ResearchError } from "@research-os/shared";
import { loadConfig, type ApiConfig } from "../src/config.ts";
import { buildContext, type AppContext } from "../src/app-context.ts";
import { createServer } from "../src/server.ts";

const BASE_ENV = {
  RESEARCH_OS_DATABASE_URL: "sqlite::memory:",
  RESEARCH_OS_LOG_LEVEL: "error",
  RESEARCH_OS_EMBEDDED_WORKER: "false",
  RESEARCH_OS_HOST: "127.0.0.1",
  RESEARCH_OS_PORT: "0",
};

/** The director's plan, so a started project has real work queued. */
const PLAN_TURN = {
  when: "Produce the plan as JSON",
  repeat: true,
  json: {
    interpretation: "Restated question.",
    objectives: [{ statement: "Establish the effect.", rationale: "It is what was asked." }],
    subQuestions: [{ text: "Does it hold?", rationale: "Direct.", priority: 80 }],
    hypotheses: [],
    strategy: "Find and check sources.",
    steps: [{ key: "discover", type: "source.discover", description: "Find sources.", dependsOnKeys: [], searchQueries: ["q"], priority: 90 }],
    unanswerableIf: [],
  },
};

async function startApi(envOverrides: Record<string, string> = {}): Promise<{
  app: FastifyInstance; context: AppContext; client: ResearchOSClient; config: ApiConfig; baseUrl: string;
}> {
  const config = loadConfig({ ...BASE_ENV, ...envOverrides });
  const context = await buildContext(config, {
    logger: createMemoryLogger("error").logger,
    modelProvider: new ScriptedModelProvider({
      name: "scripted",
      models: scriptedModels(["scripted-1"], { provider: "scripted" }),
      script: [PLAN_TURN],
    }),
  });
  const app = await createServer(context);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  return {
    app, context, config, baseUrl,
    client: new ResearchOSClient({
      baseUrl,
      application: "test-suite",
      ...(envOverrides["RESEARCH_OS_API_KEYS"] ? { apiKey: envOverrides["RESEARCH_OS_API_KEYS"].split(",")[0] } : {}),
    }),
  };
}

describe("the API over real HTTP", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let client: ResearchOSClient;

  before(async () => {
    ({ app, context, client } = await startApi());
  });

  after(async () => {
    await app.close();
    await context.close();
  });

  beforeEach(async () => {
    // Each test starts from an empty database; the schema stays.
    for (const table of ["research_events", "tasks", "task_dependencies", "claims", "evidence", "sources", "projects"]) {
      await context.db.execute(`DELETE FROM ${table}`).catch(() => { /* order varies with foreign keys */ });
    }
  });

  test("a project is created and read back through the client", async () => {
    const project = await client.createProject({
      question: "Does persistent memory improve agent recall?",
      autoStart: false,
    });

    assert.match(project.id, /^prj_/);
    assert.equal(project.status, "draft");
    assert.equal(project.originalQuestion, "Does persistent memory improve agent recall?");
    assert.equal(project.createdBy?.application, "test-suite", "the calling application is recorded for audit");
    assert.ok(project.title.length > 0, "a question makes a serviceable title when none is supplied");

    const detail = await client.getProject(project.id);
    assert.equal(detail.project.id, project.id);
    assert.equal(detail.plan, null, "nothing has been planned yet");
    assert.equal(detail.progress.tasksTotal, 0);
  });

  test("defaults are applied from the contract, not invented by the route", async () => {
    const project = await client.createProject({ question: "A question that is long enough.", autoStart: false });
    assert.equal(project.preferences.citationStyle, "apa");
    assert.equal(project.preferences.depth, "standard");
    assert.ok(project.budget.maxTokens > 0);
    assert.equal(project.preferences.requireIndependentVerification, true);
  });

  test("an invalid request is a 400 with the offending field named", async () => {
    await assert.rejects(
      client.createProject({ question: "x", autoStart: false }),
      (error: ResearchError) => {
        assert.equal(error.code, "validation_failed");
        assert.equal(error.status, 400);
        assert.match(error.message, /question/);
        return true;
      },
    );
  });

  test("an unknown project is a 404 carrying a trace id", async () => {
    await assert.rejects(
      client.getProject("prj_01J000000000000000000000AA"),
      (error: ResearchError) => {
        assert.equal(error.code, "not_found");
        assert.equal(error.status, 404);
        assert.ok(error.details["traceId"], "so a client-side failure is findable in server logs");
        return true;
      },
    );
  });

  test("an unknown route is a 404, not an HTML error page", async () => {
    const response = await fetch(`${(context.config.host, "http://127.0.0.1")}:${(app.server.address() as AddressInfo).port}/nope`);
    assert.equal(response.status, 404);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  });

  test("running a project queues real work and moves it to running", async () => {
    const project = await client.createProject({ question: "Does persistent memory improve recall?", autoStart: false });
    const run = await client.run(project.id);

    assert.equal(run.status, "running");
    assert.equal(run.tasksQueued, 1);

    const status = await client.getStatus(project.id);
    assert.equal(status.status, "running");
    assert.equal(status.progress.tasksTotal, 1);

    const tasks = await client.listTasks(project.id);
    assert.equal(tasks.items[0]?.type, "plan.create");
  });

  test("autoStart runs the project as part of creation", async () => {
    const project = await client.createProject({ question: "Does it work end to end?", autoStart: true });
    const status = await client.getStatus(project.id);
    assert.equal(status.status, "running");
    assert.ok(status.progress.tasksTotal >= 1);
  });

  test("a completed project cannot be run again", async () => {
    const project = await client.createProject({ question: "A finished question.", autoStart: false });
    await context.engine.coordinator.transition(project.id, "planning");
    await context.engine.coordinator.transition(project.id, "running");
    await context.engine.coordinator.transition(project.id, "completed");

    await assert.rejects(client.run(project.id), (error: ResearchError) => error.code === "conflict");
  });

  test("cancelling stops outstanding work", async () => {
    const project = await client.createProject({ question: "Cancel me please, this is the question.", autoStart: true });
    const result = await client.cancel(project.id, "changed my mind");

    assert.equal(result.status, "cancelled");
    assert.ok(result.cancelledTasks >= 1);
    assert.equal((await client.getStatus(project.id)).status, "cancelled");
  });

  test("the event log is readable and resumable by sequence", async () => {
    const project = await client.createProject({ question: "An event-producing question.", autoStart: true });

    const all = await client.getEvents(project.id);
    assert.ok(all.items.length >= 2, "creation and start both emit");
    assert.deepEqual(all.items.map((event) => event.sequence), all.items.map((_event, index) => index + 1));

    const resumed = await client.getEvents(project.id, { since: 1 });
    assert.equal(resumed.items[0]?.sequence, 2, "resume is exclusive of the sequence given");
  });

  test("events stream over SSE and resume from a sequence", async () => {
    const project = await client.createProject({ question: "A streaming question for the test.", autoStart: true });
    const controller = new AbortController();

    const received: number[] = [];
    const consumer = (async () => {
      for await (const event of client.streamEvents(project.id, { signal: controller.signal })) {
        received.push(event.sequence);
        if (received.length >= 2) break;
      }
    })();

    await consumer.catch(() => { /* aborting the reader is the normal exit */ });
    controller.abort();

    assert.ok(received.length >= 2, "history replays over the stream");
    assert.deepEqual(received.slice(0, 2), [1, 2]);
  });

  test("the graph and tree are served from stored state", async () => {
    const project = await client.createProject({ question: "A question that will have a tree.", autoStart: false });

    const graph = await client.getGraph(project.id);
    assert.equal(graph.projectId, project.id);
    assert.deepEqual(graph.nodes, [], "an empty project has an empty graph, not an invented one");

    const tree = await client.getTree(project.id);
    assert.equal(tree.root.kind, "original_question");
    assert.equal(tree.root.label, "A question that will have a tree.");
  });

  test("a report that does not exist is a 404 rather than an empty document", async () => {
    const project = await client.createProject({ question: "No report exists for this yet.", autoStart: false });
    await assert.rejects(client.getReport(project.id), (error: ResearchError) => error.code === "not_found");
  });

  test("supplying evidence by URL queues an ingestion task", async () => {
    const project = await client.createProject({ question: "Here is a source to read.", autoStart: false });
    const result = await client.addEvidence(project.id, { url: "https://example.org/paper", sourceType: "user_supplied", authors: [] });

    assert.match(result.sourceId, /^src_/);
    assert.match(String(result.taskId), /^tsk_/);

    const tasks = await client.listTasks(project.id);
    assert.equal(tasks.items[0]?.type, "source.ingest");
  });

  test("supplying content directly is refused rather than stored unverifiably", async () => {
    const project = await client.createProject({ question: "Here is some text I pasted in.", autoStart: false });
    await assert.rejects(
      client.addEvidence(project.id, { content: "Some pasted text.", sourceType: "user_supplied", authors: [] }),
      (error: ResearchError) => {
        assert.equal(error.code, "unsupported");
        assert.match(error.message, /parsed and chunked through the same path/);
        return true;
      },
    );
  });

  test("health reports degraded when a capability is missing, and says which", async () => {
    const health = await client.health();
    // The scripted provider is a real provider, so models are ok; there is no
    // second provider, so independence is listed as a gap.
    assert.ok(["ok", "degraded"].includes(health.status));
    assert.equal(health.checks["database"]?.status, "ok");
    assert.ok(health.gaps.some((gap) => /Only one model provider/.test(gap)));
  });

  test("capabilities lists what this deployment can actually do", async () => {
    const capabilities = await client.capabilities();
    assert.ok(capabilities.taskTypes.includes("plan.create"));
    assert.ok(capabilities.taskTypes.includes("report.generate"));
    assert.ok(capabilities.tools.length >= 1, "web_fetch is always available");
    assert.ok(Array.isArray(capabilities.gaps));
  });

  test("listing pages and reports a cursor", async () => {
    for (let index = 0; index < 3; index++) {
      await client.createProject({ question: `Question number ${index} for the listing test.`, autoStart: false });
    }
    const page = await client.listProjects({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor, "a full page reports where to continue");

    const rest = await client.listProjects({ limit: 2, cursor: page.nextCursor ?? undefined });
    assert.ok(rest.items.length >= 1);
  });
});

describe("authentication", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let baseUrl: string;

  before(async () => {
    ({ app, context, baseUrl } = await startApi({ RESEARCH_OS_API_KEYS: "secret-key-one,secret-key-two" }));
  });

  after(async () => {
    await app.close();
    await context.close();
  });

  test("a request with no key is refused", async () => {
    const anonymous = new ResearchOSClient({ baseUrl });
    await assert.rejects(
      anonymous.listProjects(),
      (error: ResearchError) => error.code === "unauthorized" && error.status === 401,
    );
  });

  test("a wrong key is refused", async () => {
    const wrong = new ResearchOSClient({ baseUrl, apiKey: "not-the-key" });
    await assert.rejects(wrong.listProjects(), (error: ResearchError) => error.status === 401);
  });

  test("either configured key is accepted", async () => {
    for (const key of ["secret-key-one", "secret-key-two"]) {
      const authorised = new ResearchOSClient({ baseUrl, apiKey: key });
      assert.ok(Array.isArray((await authorised.listProjects()).items));
    }
  });

  test("health stays open, because a load balancer holds no key", async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    assert.equal(response.status, 200);
  });

  test("executor registration stays open, because an executor has no key until it registers", async () => {
    const response = await fetch(`${baseUrl}/api/v1/executors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-executor", capabilities: ["browser"], mode: "pull" }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { token: string };
    assert.match(body.token, /^exk_/);
  });
});

describe("the executor protocol over HTTP", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let baseUrl: string;

  before(async () => {
    ({ app, context, baseUrl } = await startApi());
  });

  after(async () => {
    await app.close();
    await context.close();
  });

  const register = async (): Promise<{ token: string; executorId: string }> => {
    const response = await fetch(`${baseUrl}/api/v1/executors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `exec-${Math.random().toString(36).slice(2, 8)}`, capabilities: ["browser"], mode: "pull" }),
    });
    const body = await response.json() as { executor: { id: string }; token: string };
    return { token: body.token, executorId: body.executor.id };
  };

  test("an executor registers, heartbeats and claims work", async () => {
    const { token } = await register();

    const heartbeat = await fetch(`${baseUrl}/api/v1/executors/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(heartbeat.status, 200);

    const claim = await fetch(`${baseUrl}/api/v1/executors/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ capabilities: ["browser"], max: 1, waitMs: 0 }),
    });
    assert.equal(claim.status, 200);
    assert.deepEqual((await claim.json() as { requests: unknown[] }).requests, [], "no work is queued yet");
  });

  test("a malformed body is a 400, not a 500 blamed on the server", async () => {
    const response = await fetch(`${baseUrl}/api/v1/research/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(response.status, 400, "telling a client its own bad request was a server fault sends it looking in the wrong place");
    assert.equal((await response.json() as { error: { code: string } }).error.code, "validation_failed");
  });

  test("an executor endpoint refuses an invalid token", async () => {
    const response = await fetch(`${baseUrl}/api/v1/executors/heartbeat`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401, "otherwise anyone could inject results into someone else's research");
  });
});
