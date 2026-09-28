/**
 * Model router behaviour.
 *
 * The router is the only thing standing between a research run and a flaky
 * provider, so the tests that matter here are the failure paths: what happens
 * when a model errors, when it keeps erroring, and when it returns something
 * that is nearly — but not quite — the JSON it was asked for.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TestClock, err, type ResearchError } from "@research-os/shared";
import { MemorySpanSink, MetricsRegistry, Tracer, createMemoryLogger } from "@research-os/observability";
import {
  ANTHROPIC_MODEL_SPECS, ModelRouter, ScriptedModelProvider, describeModels, pricingFromEnv,
  scriptedModels, type ModelCallRecord,
} from "../src/index.ts";

const NO_JITTER = { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, multiplier: 2, jitter: 0 };

function makeRouter(options: {
  providers: ScriptedModelProvider[];
  clock?: TestClock;
  onModelCall?: (record: ModelCallRecord) => void;
  breakerThreshold?: number;
} ) {
  const clock = options.clock ?? new TestClock();
  const metrics = new MetricsRegistry();
  const logger = createMemoryLogger();
  const router = new ModelRouter({
    providers: options.providers,
    rules: [
      { taskKind: "analysis", candidates: options.providers.flatMap((p) => p.models.map((m) => ({ provider: p.name, model: m.id }))), requiredCapabilities: ["text"], requireDistinctProvider: false },
      { taskKind: "extraction", candidates: options.providers.flatMap((p) => p.models.map((m) => ({ provider: p.name, model: m.id }))), requiredCapabilities: ["structured_output"], requireDistinctProvider: false },
      { taskKind: "verification", candidates: options.providers.flatMap((p) => p.models.map((m) => ({ provider: p.name, model: m.id }))), requiredCapabilities: ["text"], requireDistinctProvider: true },
    ],
    clock,
    metrics,
    logger: logger.logger,
    retryPolicy: NO_JITTER,
    random: () => 0,
    ...(options.onModelCall ? { onModelCall: options.onModelCall } : {}),
    ...(options.breakerThreshold === undefined ? {} : { breakerThreshold: options.breakerThreshold }),
  });
  return { router, clock, metrics, logs: logger };
}

const transient = (): ResearchError => err.provider("503 overloaded", { retryable: true });
const permanent = (): ResearchError => err.provider("400 bad request", { retryable: false });

describe("routing", () => {
  test("picks the first candidate that satisfies the required capabilities", () => {
    const weak = new ScriptedModelProvider({
      name: "weak",
      models: scriptedModels(["weak-1"], { provider: "weak", capabilities: ["text"] }),
    });
    const strong = new ScriptedModelProvider({
      name: "strong",
      models: scriptedModels(["strong-1"], { provider: "strong", capabilities: ["text", "structured_output"] }),
    });
    const { router } = makeRouter({ providers: [weak, strong] });

    assert.equal(router.route({ taskKind: "analysis" }).chosen.descriptor.id, "weak-1", "declared order is preference");
    assert.equal(
      router.route({ taskKind: "extraction" }).chosen.descriptor.id,
      "strong-1",
      "a model lacking structured_output must be skipped, not merely deprioritised",
    );
  });

  test("a model whose context window is too small is not chosen", () => {
    const small = new ScriptedModelProvider({ name: "small", models: scriptedModels(["small-1"], { provider: "small", maxInputTokens: 1000 }) });
    const large = new ScriptedModelProvider({ name: "large", models: scriptedModels(["large-1"], { provider: "large", maxInputTokens: 500_000 }) });
    const { router } = makeRouter({ providers: [small, large] });

    assert.equal(router.route({ taskKind: "analysis", minInputTokens: 300_000 }).chosen.descriptor.id, "large-1");
  });

  test("an unroutable request explains itself rather than failing generically", () => {
    const provider = new ScriptedModelProvider({ name: "p", models: scriptedModels(["m"], { provider: "p", capabilities: ["text"] }) });
    const { router } = makeRouter({ providers: [provider] });

    assert.throws(
      () => router.route({ taskKind: "vision" }),
      (error: ResearchError) => error.code === "unsupported" && /No routing rule/.test(error.message),
    );
    assert.throws(
      () => router.route({ taskKind: "analysis", requiredCapabilities: ["embedding"] }),
      (error: ResearchError) => error.code === "unsupported" && /embedding/.test(error.message),
    );
  });

  test("an override pins the model and bypasses the policy", () => {
    const provider = new ScriptedModelProvider({ name: "p", models: scriptedModels(["a", "b"], { provider: "p" }) });
    const { router } = makeRouter({ providers: [provider] });

    assert.equal(router.route({ taskKind: "analysis", overrideModel: "b" }).chosen.descriptor.id, "b");
    assert.throws(
      () => router.route({ taskKind: "analysis", overrideModel: "nonexistent" }),
      (error: ResearchError) => error.code === "unsupported",
    );
  });
});

describe("independent verification", () => {
  test("routes away from the provider under review when a second one exists", () => {
    const a = new ScriptedModelProvider({ name: "a", models: scriptedModels(["a-1"], { provider: "a" }) });
    const b = new ScriptedModelProvider({ name: "b", models: scriptedModels(["b-1"], { provider: "b" }) });
    const { router } = makeRouter({ providers: [a, b] });

    const decision = router.route({ taskKind: "verification", excludeProvider: "a" });
    assert.equal(decision.chosen.provider.name, "b");
    assert.equal(decision.independent, true);
    assert.equal(decision.independenceRequested, true);
  });

  test("with only one provider it reports a self-review instead of pretending", () => {
    const only = new ScriptedModelProvider({ name: "only", models: scriptedModels(["only-1"], { provider: "only" }) });
    const { router, logs } = makeRouter({ providers: [only] });

    const decision = router.route({ taskKind: "verification", excludeProvider: "only" });
    assert.equal(decision.chosen.provider.name, "only", "verification still runs");
    assert.equal(decision.independenceRequested, true);
    assert.equal(decision.independent, false, "but it must not be reported as independent");
    assert.ok(
      logs.lines.some((line) => line["level"] === "warn" && /Independent verification unavailable/.test(String(line["message"]))),
      "and the degradation must be visible in the logs",
    );
  });

  test("independence is not claimed when it was never requested", () => {
    const only = new ScriptedModelProvider({ name: "only", models: scriptedModels(["only-1"], { provider: "only" }) });
    const { router } = makeRouter({ providers: [only] });
    const decision = router.route({ taskKind: "analysis" });
    assert.equal(decision.independenceRequested, false);
    assert.equal(decision.independent, true, "a request with no independence requirement is trivially satisfied");
  });
});

describe("retry and fallback", () => {
  test("a transient failure is retried on the same model", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ error: transient() }, { error: transient() }, { text: "recovered" }],
    });
    const { router, clock } = makeRouter({ providers: [provider] });

    const result = await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hello" }] });

    assert.equal(result.response.text, "recovered");
    assert.equal(result.attempts, 3);
    assert.deepEqual(clock.sleeps, [10, 20], "exponential backoff between attempts");
  });

  test("a permanent failure is not retried", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ error: permanent() }, { text: "never reached" }],
    });
    const { router } = makeRouter({ providers: [provider] });

    await assert.rejects(
      router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hi" }] }),
      (error: ResearchError) => error.code === "provider_error" && /400/.test(error.message),
    );
    assert.equal(provider.requests.length, 1, "retrying a malformed request would only burn budget");
  });

  test("an exhausted model falls back to the next candidate", async () => {
    const broken = new ScriptedModelProvider({
      name: "broken",
      models: scriptedModels(["broken-1"], { provider: "broken" }),
      script: [{ error: transient(), repeat: true }],
    });
    const healthy = new ScriptedModelProvider({
      name: "healthy",
      models: scriptedModels(["healthy-1"], { provider: "healthy" }),
      script: [{ text: "served by the fallback" }],
    });
    const { router } = makeRouter({ providers: [broken, healthy] });

    const result = await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hi" }] });

    assert.equal(result.response.text, "served by the fallback");
    assert.equal(result.response.provider, "healthy");
    assert.equal(broken.requests.length, 3, "the first model is retried to exhaustion before falling back");
  });

  test("when every candidate fails, the last error is surfaced", async () => {
    const a = new ScriptedModelProvider({ name: "a", models: scriptedModels(["a-1"], { provider: "a" }), script: [{ error: transient(), repeat: true }] });
    const b = new ScriptedModelProvider({ name: "b", models: scriptedModels(["b-1"], { provider: "b" }), script: [{ error: permanent(), repeat: true }] });
    const { router } = makeRouter({ providers: [a, b] });

    await assert.rejects(
      router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hi" }] }),
      (error: ResearchError) => /400/.test(error.message),
    );
  });
});

describe("circuit breaker", () => {
  test("a repeatedly failing provider is moved behind a healthy one", async () => {
    const broken = new ScriptedModelProvider({ name: "broken", models: scriptedModels(["broken-1"], { provider: "broken" }), script: [{ error: transient(), repeat: true }] });
    const healthy = new ScriptedModelProvider({ name: "healthy", models: scriptedModels(["healthy-1"], { provider: "healthy" }), script: [{ text: "ok", repeat: true }] });
    const { router } = makeRouter({ providers: [broken, healthy], breakerThreshold: 2 });

    await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "one" }] });
    assert.equal(router.breakerStatus()["broken"]?.open, true, "the failing provider is in cooldown");

    const attemptsBefore = broken.requests.length;
    const second = await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "two" }] });

    assert.equal(second.response.provider, "healthy");
    assert.equal(broken.requests.length, attemptsBefore, "a provider in cooldown is not called again");
  });

  test("the cooldown expires and the provider is tried again", async () => {
    const flaky = new ScriptedModelProvider({ name: "flaky", models: scriptedModels(["flaky-1"], { provider: "flaky" }), script: [{ error: transient(), repeat: true }] });
    const backup = new ScriptedModelProvider({ name: "backup", models: scriptedModels(["backup-1"], { provider: "backup" }), script: [{ text: "ok", repeat: true }] });
    const clock = new TestClock();
    const { router } = makeRouter({ providers: [flaky, backup], clock, breakerThreshold: 2 });

    await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "one" }] });
    assert.equal(router.breakerStatus()["flaky"]?.open, true);

    clock.advance(31_000);
    assert.equal(router.breakerStatus()["flaky"]?.open, false, "cooldown is a timeout, not a permanent removal");
  });

  test("success clears the failure count", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ error: transient() }, { text: "ok" }],
    });
    const { router } = makeRouter({ providers: [provider], breakerThreshold: 5 });

    await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hi" }] });
    assert.equal(router.breakerStatus()["p"]?.consecutiveFailures, 0);
  });
});

describe("structured output", () => {
  const Plan = z.object({
    question: z.string().min(1),
    steps: z.array(z.object({ description: z.string(), rationale: z.string() })).min(1),
  });

  test("valid JSON is parsed and typed", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ json: { question: "Does memory help?", steps: [{ description: "Search", rationale: "Establish a baseline" }] } }],
    });
    const { router } = makeRouter({ providers: [provider] });

    const result = await router.structured({
      taskKind: "extraction",
      schema: Plan,
      messages: [{ role: "user", content: "plan it" }],
    });

    assert.equal(result.value.question, "Does memory help?");
    assert.equal(result.value.steps[0]?.description, "Search");
    assert.equal(result.repairs, 0);
  });

  test("JSON wrapped in prose and a code fence is still recovered", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ text: 'Here is the plan:\n```json\n{"question":"Q","steps":[{"description":"d","rationale":"r"}]}\n```\nHope that helps!' }],
    });
    const { router } = makeRouter({ providers: [provider] });

    const result = await router.structured({ taskKind: "extraction", schema: Plan, messages: [{ role: "user", content: "plan" }] });
    assert.equal(result.value.question, "Q");
    assert.equal(result.repairs, 0, "unwrapping is not a repair — no second call was made");
  });

  test("a schema violation is fed back and repaired", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [
        { json: { question: "Q", steps: [] } },
        { json: { question: "Q", steps: [{ description: "d", rationale: "r" }] } },
      ],
    });
    const { router } = makeRouter({ providers: [provider] });

    const result = await router.structured({ taskKind: "extraction", schema: Plan, messages: [{ role: "user", content: "plan" }] });

    assert.equal(result.repairs, 1);
    assert.equal(result.value.steps.length, 1);

    const repairPrompt = provider.requests[1]?.messages.at(-1)?.content ?? "";
    assert.match(repairPrompt, /could not be used/, "the model is told what was wrong");
    assert.match(repairPrompt, /steps/, "and which field failed");
  });

  test("output that never validates fails loudly rather than returning something shaped wrong", async () => {
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ text: "I would rather write an essay about this.", repeat: true }],
    });
    const { router } = makeRouter({ providers: [provider] });

    await assert.rejects(
      router.structured({ taskKind: "extraction", schema: Plan, messages: [{ role: "user", content: "plan" }], maxRepairAttempts: 1 }),
      (error: ResearchError) => error.code === "validation_failed" && /repair attempt/.test(error.message),
    );
    assert.equal(provider.requests.length, 2, "one initial call plus one repair");
  });
});

describe("accounting and observability", () => {
  test("every call is reported with real token counts and cost", async () => {
    const records: ModelCallRecord[] = [];
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p", inputCostPerMTokUsd: 3, outputCostPerMTokUsd: 15 }),
      script: [{ text: "a reasonably long answer that costs a measurable amount of money" }],
    });
    const { router, metrics } = makeRouter({ providers: [provider], onModelCall: (record) => records.push(record) });

    const result = await router.complete({
      taskKind: "analysis",
      system: "You are a research analyst.",
      messages: [{ role: "user", content: "Summarise the evidence on persistent memory." }],
    });

    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.succeeded, true);
    assert.equal(record.provider, "p");
    assert.equal(record.taskKind, "analysis");
    assert.ok(record.inputTokens > 0, "the system prompt and messages are both counted");
    assert.ok(record.outputTokens > 0);
    assert.ok(record.costUsd > 0, "cost is computed from the descriptor's real rates");
    assert.equal(record.costUsd, result.response.usage.costUsd);
    assert.equal(metrics.counter("model.call", { provider: "p", model: "m" }), 1);
  });

  test("failed calls are recorded too, so the ledger shows what a run really did", async () => {
    const records: ModelCallRecord[] = [];
    const provider = new ScriptedModelProvider({
      name: "p",
      models: scriptedModels(["m"], { provider: "p" }),
      script: [{ error: transient() }, { text: "ok" }],
    });
    const { router } = makeRouter({ providers: [provider], onModelCall: (record) => records.push(record) });

    await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hi" }] });

    assert.equal(records.length, 2);
    assert.equal(records[0]?.succeeded, false);
    assert.match(String(records[0]?.errorMessage), /503/);
    assert.equal(records[1]?.succeeded, true);
  });

  test("a span is emitted per model call", async () => {
    const sink = new MemorySpanSink();
    const provider = new ScriptedModelProvider({ name: "p", models: scriptedModels(["m"], { provider: "p" }), script: [{ text: "ok" }] });
    const router = new ModelRouter({
      providers: [provider],
      rules: [{ taskKind: "analysis", candidates: [{ provider: "p", model: "m" }], requiredCapabilities: [], requireDistinctProvider: false }],
      tracer: new Tracer({ sink }),
      retryPolicy: NO_JITTER,
    });

    await router.complete({ taskKind: "analysis", messages: [{ role: "user", content: "hi" }] });

    assert.equal(sink.spans.length, 1);
    assert.equal(sink.spans[0]?.kind, "model_call");
    assert.equal(sink.spans[0]?.attributes["provider"], "p");
    assert.equal(sink.spans[0]?.attributes["taskKind"], "analysis");
    assert.ok(Number(sink.spans[0]?.attributes["outputTokens"]) > 0);
  });
});

/*
 * The schema has to survive the whole journey, not just be computed.
 *
 * `structured()` converts the zod schema so a provider can constrain decoding,
 * but `#callProvider` rebuilds the request field by field — so anything not
 * explicitly forwarded is dropped silently between the two. That is exactly
 * what happened: native structured output was dead code, providers never saw a
 * schema, and a model returned a plausible wrong shape that cost two repair
 * rounds and then failed. These tests watch the far end of the pipe.
 */
describe("structured output reaches the provider", () => {
  const Plan = z.object({
    objectives: z.array(z.object({ statement: z.string().min(1), rationale: z.string() })).min(1),
    priority: z.number().int().min(0).max(100),
  });
  const valid = { objectives: [{ statement: "s", rationale: "r" }], priority: 50 };

  test("the zod schema arrives at the provider as JSON Schema", async () => {
    const provider = new ScriptedModelProvider({
      name: "p", models: scriptedModels(["m"], { provider: "p" }), script: [{ json: valid }],
    });
    const { router } = makeRouter({ providers: [provider] });
    await router.structured({ taskKind: "extraction", schema: Plan, messages: [{ role: "user", content: "go" }] });

    const sent = provider.requests[0]?.jsonSchema;
    assert.ok(sent, "the provider received no schema, so native structured output is unreachable");
    const properties = sent["properties"] as Record<string, unknown>;
    assert.ok(properties["objectives"], "the shape must survive, not just the outer object");
    assert.ok(properties["priority"]);
  });

  test("the nested shape survives, not just the top level", async () => {
    const provider = new ScriptedModelProvider({
      name: "p", models: scriptedModels(["m"], { provider: "p" }), script: [{ json: valid }],
    });
    await makeRouter({ providers: [provider] }).router
      .structured({ taskKind: "extraction", schema: Plan, messages: [{ role: "user", content: "go" }] });

    const sent = provider.requests[0]?.jsonSchema as Record<string, Record<string, Record<string, unknown>>>;
    const item = sent["properties"]?.["objectives"]?.["items"] as Record<string, unknown> | undefined;
    const fields = item?.["properties"] as Record<string, unknown> | undefined;
    assert.ok(fields?.["statement"], "an object-in-array shape is where a model most often guesses wrong");
    assert.ok(fields?.["rationale"]);
  });

  test("a repair round still carries the schema", async () => {
    const provider = new ScriptedModelProvider({
      name: "p", models: scriptedModels(["m"], { provider: "p" }),
      script: [{ text: "not json at all" }, { json: valid }],
    });
    const out = await makeRouter({ providers: [provider] }).router
      .structured({ taskKind: "extraction", schema: Plan, messages: [{ role: "user", content: "go" }] });

    assert.equal(out.repairs, 1);
    assert.ok(provider.requests[1]?.jsonSchema, "dropping the schema on the retry would make repair strictly harder");
  });

  test("a plain completion carries no schema", async () => {
    const provider = new ScriptedModelProvider({
      name: "p", models: scriptedModels(["m"], { provider: "p" }), fallbackText: "hello",
    });
    await makeRouter({ providers: [provider] }).router
      .complete({ taskKind: "extraction", messages: [{ role: "user", content: "go" }] });

    assert.equal(provider.requests[0]?.jsonSchema, undefined,
      "an unstructured call must not silently constrain the model");
  });
});

describe("catalog and pricing", () => {
  test("a model with no configured price is refused at construction", () => {
    assert.throws(
      () => describeModels("anthropic", ANTHROPIC_MODEL_SPECS, {}),
      (error: ResearchError) =>
        error.code === "validation_failed" && /RESEARCH_OS_MODEL_PRICING/.test(error.message),
      "billing at zero would silently corrupt every budget decision",
    );
  });

  test("configured pricing produces complete descriptors", () => {
    const descriptors = describeModels("anthropic", ANTHROPIC_MODEL_SPECS, Object.fromEntries(
      ANTHROPIC_MODEL_SPECS.map((spec) => [spec.id, { inputCostPerMTokUsd: 3, outputCostPerMTokUsd: 15 }]),
    ));
    assert.equal(descriptors.length, ANTHROPIC_MODEL_SPECS.length);
    assert.equal(descriptors[0]?.provider, "anthropic");
    assert.equal(descriptors[0]?.inputCostPerMTokUsd, 3);
  });

  test("pricing is read from the environment", () => {
    const table = pricingFromEnv({
      RESEARCH_OS_MODEL_PRICING: '{"claude-sonnet-5":{"inputCostPerMTokUsd":3,"outputCostPerMTokUsd":15,"cachedInputCostPerMTokUsd":0.3}}',
    });
    assert.equal(table["claude-sonnet-5"]?.inputCostPerMTokUsd, 3);
    assert.equal(table["claude-sonnet-5"]?.cachedInputCostPerMTokUsd, 0.3);
    assert.deepEqual(pricingFromEnv({}), {}, "an unset variable is not an error here — the provider reports it");
  });

  test("malformed pricing is rejected with the offending model named", () => {
    assert.throws(
      () => pricingFromEnv({ RESEARCH_OS_MODEL_PRICING: '{"m":{"inputCostPerMTokUsd":"three"}}' }),
      (error: ResearchError) => /"m"/.test(error.message),
    );
  });
});
