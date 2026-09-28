/**
 * The registry and the web_fetch tool, against a real HTTP server.
 *
 * `web_fetch` is tested against an actual `node:http` server rather than a
 * mocked fetch, because the things most likely to be wrong — redirect handling,
 * the byte ceiling, content-type negotiation, streaming — only behave
 * realistically against a real socket.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { ToolDescriptor, ToolPermissionPolicy } from "@research-os/contracts";
import { TestClock } from "@research-os/shared";
import {
  LocalToolProvider, ToolRegistry, WebFetchTool,
  type ResearchTool, type ToolCallReport, type ToolContext,
} from "../src/index.ts";

const PROJECT = "prj_test";

function policy(overrides: Record<string, unknown> = {}) {
  return ToolPermissionPolicy.parse({
    allowedToolIds: ["web_fetch", "reflect"],
    allowedCapabilities: ["web_fetch", "http_request"],
    maxRiskLevel: "read_only",
    ...overrides,
  });
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { projectId: PROJECT, taskId: "tsk_1", policy: policy(), ...overrides };
}

/** A trivial local tool, for exercising the registry without the network. */
const ReflectInput = z.object({ message: z.string().min(1) });
class ReflectTool implements ResearchTool<z.infer<typeof ReflectInput>, { reflected: string }> {
  readonly inputSchema = ReflectInput;
  calls = 0;
  #delayMs: number;
  readonly descriptor = ToolDescriptor.parse({
    id: "reflect", name: "Reflect", description: "Returns what it is given.",
    capability: "http_request", riskLevel: "read_only",
    inputSchema: z.toJSONSchema(ReflectInput) as Record<string, unknown>, provider: "local",
  });
  constructor(delayMs = 0) { this.#delayMs = delayMs; }
  async execute(input: z.infer<typeof ReflectInput>): Promise<{ reflected: string }> {
    this.calls++;
    if (this.#delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    return { reflected: input.message };
  }
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;
  let reflect: ReflectTool;
  let reports: ToolCallReport[];

  beforeEach(async () => {
    reflect = new ReflectTool();
    reports = [];
    registry = new ToolRegistry({
      providers: [new LocalToolProvider([reflect])],
      onToolCall: (report) => { reports.push(report); },
    });
    await registry.refresh();
  });

  test("a permitted call runs and is recorded", async () => {
    const outcome = await registry.call("reflect", { message: "hello" }, context());

    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(outcome.status === "succeeded" ? outcome.output : null, { reflected: "hello" });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.status, "succeeded");
    assert.equal(reports[0]?.projectId, PROJECT);
    assert.equal(reports[0]?.provider, "local");
  });

  test("a call the policy forbids is denied, recorded, and does not reach the tool", async () => {
    const outcome = await registry.call("reflect", { message: "hi" }, context({ policy: policy({ allowedToolIds: [] }) }));

    assert.equal(outcome.status, "denied");
    assert.equal(reflect.calls, 0, "a denied tool must never execute");
    assert.equal(reports[0]?.status, "denied", "and the refusal is part of the audit trail");
    assert.match(outcome.status === "denied" ? outcome.errorMessage : "", /does not list tool/);
  });

  test("an unknown tool is denied rather than throwing", async () => {
    const outcome = await registry.call("rm_rf", { message: "x" }, context());
    assert.equal(outcome.status, "denied");
    assert.match(outcome.status === "denied" ? outcome.errorMessage : "", /No registered provider/);
  });

  test("invalid input is rejected before the tool runs", async () => {
    const outcome = await registry.call("reflect", { message: 42 }, context());
    assert.equal(outcome.status, "failed");
    assert.equal(reflect.calls, 0, "a tool never sees input that failed its own schema");
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /is invalid/);
  });

  test("the per-task call budget stops a looping agent", async () => {
    const limited = context({ policy: policy({ maxCallsPerTask: 2 }) });

    assert.equal((await registry.call("reflect", { message: "1" }, limited)).status, "succeeded");
    assert.equal((await registry.call("reflect", { message: "2" }, limited)).status, "succeeded");
    const third = await registry.call("reflect", { message: "3" }, limited);

    assert.equal(third.status, "denied");
    assert.match(third.status === "denied" ? third.errorMessage : "", /permitted tool calls/);
    assert.equal(reflect.calls, 2);
  });

  test("the budget is per task, and resets when the task does", async () => {
    const limited = context({ policy: policy({ maxCallsPerTask: 1 }) });
    await registry.call("reflect", { message: "1" }, limited);
    assert.equal((await registry.call("reflect", { message: "2" }, limited)).status, "denied");

    const otherTask = context({ taskId: "tsk_2", policy: policy({ maxCallsPerTask: 1 }) });
    assert.equal((await registry.call("reflect", { message: "3" }, otherTask)).status, "succeeded");

    registry.resetTask("tsk_1");
    assert.equal((await registry.call("reflect", { message: "4" }, limited)).status, "succeeded");
  });

  test("a hung tool times out instead of wedging the run", async () => {
    const slow = new ReflectTool(5000);
    const slowRegistry = new ToolRegistry({ providers: [new LocalToolProvider([slow])], onToolCall: (r) => { reports.push(r); } });
    await slowRegistry.refresh();

    const outcome = await slowRegistry.call("reflect", { message: "hi" }, context(), { timeoutMs: 30 });

    assert.equal(outcome.status, "timed_out");
    assert.equal(reports.at(-1)?.status, "timed_out");
  });

  test("listPermitted shows an agent only what it may actually call", async () => {
    assert.deepEqual(registry.listAll().map((d) => d.id), ["reflect"]);
    assert.deepEqual(registry.listPermitted(policy()).map((d) => d.id), ["reflect"]);
    assert.deepEqual(registry.listPermitted(policy({ allowedToolIds: [] })), []);
  });

  test("describeForModel emits the schema a model provider expects", () => {
    const [described] = registry.describeForModel(policy());
    assert.equal(described?.name, "reflect");
    assert.ok(described?.description.length);
    assert.equal(typeof described?.inputSchema, "object");
  });

  test("a duplicate tool id is refused at registration", () => {
    assert.throws(() => new LocalToolProvider([new ReflectTool(), new ReflectTool()]), /already registered/);
  });

  test("the clock is injectable, so durations are deterministic", async () => {
    const clock = new TestClock();
    const deterministic = new ToolRegistry({
      providers: [new LocalToolProvider([new ReflectTool()])],
      clock,
      onToolCall: (report) => { reports.push(report); },
    });
    await deterministic.refresh();
    await deterministic.call("reflect", { message: "x" }, context());
    assert.equal(reports.at(-1)?.durationMs, 0);
  });
});

describe("WebFetchTool against a real server", () => {
  let server: Server;
  let base: string;
  let registry: ToolRegistry;
  let reports: ToolCallReport[];

  before(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      switch (url.pathname) {
        case "/page":
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end("<html><body>  Persistent   memory\n\n improves recall.  </body></html>");
          return;
        case "/json":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ finding: "memory helps" }));
          return;
        case "/redirect":
          response.writeHead(302, { location: `${base}/page` });
          response.end();
          return;
        case "/redirect-to-metadata":
          response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
          response.end();
          return;
        case "/loop":
          response.writeHead(302, { location: `${base}/loop` });
          response.end();
          return;
        case "/binary":
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end(Buffer.from([0x25, 0x50, 0x44, 0x46]));
          return;
        case "/huge":
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("x".repeat(100_000));
          return;
        case "/missing":
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
          return;
        default:
          response.writeHead(400);
          response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    reports = [];
    registry = new ToolRegistry({
      // The test server is on loopback, which the SSRF guard blocks by default.
      // Naming 127.0.0.1 is the same exemption an operator grants an internal
      // corpus host — and it exempts that host alone, which is exactly what the
      // metadata-redirect test below relies on.
      providers: [new LocalToolProvider([new WebFetchTool({ allowedPrivateHosts: ["127.0.0.1"], maxBytes: 50_000 })])],
      onToolCall: (report) => { reports.push(report); },
    });
    await registry.refresh();
  });

  test("fetches a page and returns it with provenance attached", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/page` }, context());
    assert.equal(outcome.status, "succeeded");

    const output = outcome.status === "succeeded"
      ? (outcome.output as { content: string; finalUrl: string; provenance: Record<string, unknown> })
      : null;

    // `normalizeWhitespace` collapses runs of spaces and tabs but keeps
    // paragraph breaks, because losing them would destroy document structure
    // that evidence extraction later depends on.
    assert.match(String(output?.content), /<body> Persistent memory/, "runs of spaces collapse to one");
    assert.match(String(output?.content), /\n\n improves recall\./, "but a paragraph break survives");
    assert.equal(output?.provenance["statusCode"], 200);
    assert.equal(output?.provenance["url"], `${base}/page`);
    assert.match(String(output?.provenance["contentType"]), /text\/html/);
    assert.equal(String(output?.provenance["contentHash"]).length, 64, "a sha256 hash, so a re-fetch can be compared");
    assert.ok(Number(output?.provenance["bytes"]) > 0);
    assert.ok(String(output?.provenance["retrievedAt"]).endsWith("Z"), "retrieval time, so staleness is knowable");
  });

  test("follows a redirect and reports the final URL, not the original", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/redirect` }, context());
    assert.equal(outcome.status, "succeeded");
    const output = outcome.status === "succeeded" ? (outcome.output as { url: string; finalUrl: string }) : null;

    assert.equal(output?.url, `${base}/redirect`, "what was asked for");
    assert.equal(output?.finalUrl, `${base}/page`, "and where the content actually came from");
  });

  test("a redirect aimed at the metadata endpoint is refused mid-chain", async () => {
    // The dangerous case: the first URL passes every check, and the server then
    // redirects somewhere that would not have.
    const outcome = await registry.call("web_fetch", { url: `${base}/redirect-to-metadata` }, context());

    assert.equal(outcome.status, "denied");
    assert.match(
      outcome.status === "denied" ? outcome.errorMessage : "",
      /link-local or private/,
      "every hop must be re-checked, not just the first",
    );
  });

  test("a redirect loop terminates instead of spinning", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/loop` }, context());
    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /redirects/);
  });

  test("a host outside the policy allowlist is refused before any request", async () => {
    const restricted = context({ policy: policy({ allowedDomains: ["arxiv.org"] }) });
    const outcome = await registry.call("web_fetch", { url: `${base}/page` }, restricted);

    assert.equal(outcome.status, "denied");
    assert.match(outcome.status === "denied" ? outcome.errorMessage : "", /not on the policy allowlist/);
  });

  test("an oversized body is truncated at the byte ceiling rather than buffered whole", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/huge` }, context());
    assert.equal(outcome.status, "succeeded");
    const output = outcome.status === "succeeded" ? (outcome.output as { content: string; truncated: boolean }) : null;

    assert.equal(output?.truncated, true);
    assert.ok((output?.content.length ?? 0) <= 50_000, "the ceiling holds");
  });

  test("maxCharacters truncates the returned text", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/page`, maxCharacters: 10 }, context());
    const output = outcome.status === "succeeded" ? (outcome.output as { content: string; truncated: boolean }) : null;
    assert.equal(output?.content.length, 10);
    assert.equal(output?.truncated, true);
  });

  test("JSON is fetched as text", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/json` }, context());
    const output = outcome.status === "succeeded" ? (outcome.output as { content: string }) : null;
    assert.match(String(output?.content), /memory helps/);
  });

  test("a binary content type is refused with an explanation", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/binary` }, context());
    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /parser tool for binary formats/);
  });

  test("an HTTP error is a failure, not an empty success", async () => {
    const outcome = await registry.call("web_fetch", { url: `${base}/missing` }, context());
    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /HTTP 404/);
    assert.equal(reports.at(-1)?.output, null, "nothing is recorded as retrieved content");
  });
});
