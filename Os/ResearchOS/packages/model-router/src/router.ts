/**
 * The model router.
 *
 * One place decides which model serves a piece of work, what happens when it
 * fails, and what the call cost. Agents call `complete` or `structured` with a
 * task kind; they never name a model, never retry, and never compute a price.
 *
 * Four behaviours make this more than a lookup table:
 *
 *   - **Fallback across candidates.** A failing model is retried under a backoff
 *     policy, and when it is exhausted the next candidate is tried. A research
 *     run should not die because one model was briefly unavailable.
 *   - **A circuit breaker per provider.** Repeated failures take a provider out
 *     of rotation for a cooldown instead of paying the timeout on every call.
 *   - **Honest independence.** A rule may demand a provider different from the
 *     one under review. When that is impossible the router says so in the
 *     decision rather than quietly returning a self-review.
 *   - **Validated structured output.** `structured` parses and validates against
 *     a schema, and feeds a validation failure back to the model as a repair
 *     prompt. Callers get a typed value or an error, never a "probably JSON".
 */
import type {
  ModelCapability, ModelDescriptor, ModelMessage, ModelResponse, ModelRoutingRule, ModelTaskKind,
} from "@research-os/contracts";
import type { Logger, MetricsRegistry, Tracer } from "@research-os/observability";
import {
  DEFAULT_RETRY_POLICY, err, extractJsonObject, isResearchError, systemClock, toResearchError,
  type Clock, type ResearchError, type RetryPolicy,
} from "@research-os/shared";
import { z } from "zod";
import { DEFAULT_ROUTING_RULES, ruleFor } from "./policy.ts";
import { applyAdaptiveTier, decideAdaptiveTier, type AdaptiveDecision, type BudgetPressure } from "./adaptive.ts";
import type { GenerateRequest, ModelCallSink, ModelProvider, ModelToolDefinition } from "./provider.ts";

export interface ModelRouterOptions {
  readonly providers: readonly ModelProvider[];
  readonly rules?: readonly ModelRoutingRule[];
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly metrics?: MetricsRegistry;
  readonly clock?: Clock;
  readonly retryPolicy?: RetryPolicy;
  /** Receives one record per completed call. Wired to the model-call ledger. */
  readonly onModelCall?: ModelCallSink;
  /** Consecutive failures before a provider is taken out of rotation. */
  readonly breakerThreshold?: number;
  readonly breakerCooldownMs?: number;
  /** Injectable for deterministic backoff in tests. */
  readonly random?: () => number;
}

export interface RouteOptions {
  readonly taskKind: ModelTaskKind;
  /**
   * How much of the run's tightest budget ceiling is spent.
   *
   * Supplied by the orchestrator, which is the only component that knows. When
   * absent, routing follows the policy unchanged — adaptive behaviour is opt-in
   * rather than something that happens by surprise.
   */
  readonly budget?: BudgetPressure;
  /** Pins a model, bypassing the policy. From `ResearchPreferences.modelOverrides`. */
  readonly overrideModel?: string;
  /** For independent review: the provider that produced the artifact under review. */
  readonly excludeProvider?: string;
  readonly requiredCapabilities?: readonly ModelCapability[];
  /** Skips models whose context window is smaller than the prompt needs. */
  readonly minInputTokens?: number;
}

export interface Candidate {
  readonly provider: ModelProvider;
  readonly descriptor: ModelDescriptor;
}

export interface RouteDecision {
  readonly chosen: Candidate;
  /** What budget pressure did to this decision, and why. Recorded, never silent. */
  readonly adaptive: AdaptiveDecision;
  /** Tried in order if the chosen candidate is exhausted. */
  readonly fallbacks: readonly Candidate[];
  readonly independenceRequested: boolean;
  /**
   * False when independence was asked for and could not be provided. The caller
   * must record this alongside the result — it is the difference between an
   * independent check and a self-review.
   */
  readonly independent: boolean;
}

export interface CompleteRequest extends RouteOptions {
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  /**
   * The shape the answer must take, for providers that can constrain decoding.
   * Set by `structured()`; a provider that ignores it is still correct, because
   * the result is validated either way.
   */
  readonly jsonSchema?: Record<string, unknown>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly signal?: AbortSignal;
}

export interface RoutedResponse {
  readonly response: ModelResponse;
  readonly decision: RouteDecision;
  /** Model calls actually made, including retries and fallbacks. */
  readonly attempts: number;
}

export interface StructuredRequest<T> extends CompleteRequest {
  readonly schema: z.ZodType<T>;
  /** Repair attempts after a parse or validation failure. */
  readonly maxRepairAttempts?: number;
}

export interface StructuredResponse<T> extends RoutedResponse {
  readonly value: T;
  /** Repair rounds used. Above zero means the model's first answer was invalid. */
  readonly repairs: number;
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

/**
 * A zod schema as JSON Schema, or `undefined` when it cannot be expressed.
 *
 * Reused subschemas are inlined rather than emitted as `$ref`: provider
 * schema dialects are narrower than JSON Schema, and a reference to a
 * definition block is the first thing they reject.
 */
function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(schema, { reused: "inline" }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export class ModelRouter {
  readonly #providers: Map<string, ModelProvider>;
  readonly #rules: readonly ModelRoutingRule[];
  readonly #logger: Logger | undefined;
  readonly #tracer: Tracer | undefined;
  readonly #metrics: MetricsRegistry | undefined;
  readonly #clock: Clock;
  readonly #retryPolicy: RetryPolicy;
  readonly #onModelCall: ModelCallSink | undefined;
  readonly #breakers = new Map<string, BreakerState>();
  readonly #breakerThreshold: number;
  readonly #breakerCooldownMs: number;
  readonly #random: () => number;

  constructor(options: ModelRouterOptions) {
    if (options.providers.length === 0) {
      throw err.validation("ModelRouter needs at least one provider.");
    }
    this.#providers = new Map(options.providers.map((provider) => [provider.name, provider]));
    this.#rules = options.rules ?? DEFAULT_ROUTING_RULES;
    this.#logger = options.logger;
    this.#tracer = options.tracer;
    this.#metrics = options.metrics;
    this.#clock = options.clock ?? systemClock;
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#onModelCall = options.onModelCall;
    this.#breakerThreshold = options.breakerThreshold ?? 3;
    this.#breakerCooldownMs = options.breakerCooldownMs ?? 30_000;
    this.#random = options.random ?? Math.random;
  }

  /** Every model the router can currently reach. */
  describe(): ModelDescriptor[] {
    return [...this.#providers.values()].flatMap((provider) => [...provider.models]);
  }

  /* ---------- Routing ---------- */

  route(options: RouteOptions): RouteDecision {
    const rule = ruleFor(this.#rules, options.taskKind);
    if (!rule && !options.overrideModel) {
      throw err.unsupported(
        `No routing rule for task kind "${options.taskKind}". Add one to the routing policy, or pin a model with overrideModel.`,
        { taskKind: options.taskKind },
      );
    }

    const required = new Set<ModelCapability>([
      ...(rule?.requiredCapabilities ?? []),
      ...(options.requiredCapabilities ?? []),
    ]);
    const independenceRequested = (rule?.requireDistinctProvider ?? false) && Boolean(options.excludeProvider);

    let ordered = options.overrideModel
      ? this.#candidatesForModel(options.overrideModel)
      : (rule?.candidates ?? []).flatMap((candidate) => this.#candidateFor(candidate.provider, candidate.model));

    /*
     * The policy is a preference, not a whitelist.
     *
     * Routing rules name specific models, and a deployment running a different
     * provider — or a test running a scripted one — has none of them. Refusing
     * to route in that case would make the shipped policy a hard dependency on
     * one vendor's model ids, which is the opposite of what this package is for.
     * So an unmatched policy falls back to whatever is registered and capable,
     * and says that it did.
     */
    if (ordered.length === 0 && !options.overrideModel) {
      ordered = this.#allCandidatesRanked(options.taskKind);
      if (ordered.length > 0) {
        this.#logger?.debug("No policy candidate is registered; routing to the best available model", {
          taskKind: options.taskKind,
          chosen: `${ordered[0]?.provider.name}/${ordered[0]?.descriptor.id}`,
        });
      }
    }

    if (ordered.length === 0) {
      throw err.unsupported(
        options.overrideModel
          ? `Model "${options.overrideModel}" is not served by any registered provider.`
          : `No model is registered at all, so task kind "${options.taskKind}" cannot be routed.`,
        { taskKind: options.taskKind, ...(options.overrideModel ? { model: options.overrideModel } : {}) },
      );
    }

    const eligible = ordered.filter((candidate) => this.#satisfies(candidate, required, options.minInputTokens));
    if (eligible.length === 0) {
      throw err.unsupported(
        `No candidate for "${options.taskKind}" satisfies the required capabilities [${[...required].join(", ")}]` +
          (options.minInputTokens ? ` with a context window of at least ${options.minInputTokens} tokens` : "") + ".",
        { taskKind: options.taskKind, required: [...required] },
      );
    }

    // Independence first, then health, then declared preference order. A broken
    // circuit is a soft preference: a provider in cooldown is moved to the back
    // rather than removed, so the router degrades instead of failing outright.
    const independent = options.excludeProvider
      ? eligible.filter((candidate) => candidate.provider.name !== options.excludeProvider)
      : [];
    const preferred = independenceRequested && independent.length > 0 ? independent : eligible;
    const ranked = [
      ...preferred.filter((candidate) => !this.#isOpen(candidate.provider.name)),
      ...preferred.filter((candidate) => this.#isOpen(candidate.provider.name)),
    ];

    /*
     * Budget pressure reorders, it never filters.
     *
     * Applied after health and independence so those still win: a cheaper model
     * that is in cooldown, or that would make a verification self-reviewed, is
     * still the wrong choice however little it costs.
     */
    const adaptive = decideAdaptiveTier(options.taskKind, options.budget ?? { pressure: 0 });
    const adapted = applyAdaptiveTier(ranked, adaptive.tier);

    const chosen = adapted[0];
    /* c8 ignore next */
    if (!chosen) throw err.internal("Routing produced no candidate after filtering.");

    if (adaptive.tier !== "none") {
      this.#logger?.info("Routing adapted to budget pressure", {
        taskKind: options.taskKind,
        tier: adaptive.tier,
        chosen: `${chosen.provider.name}/${chosen.descriptor.id}`,
        reason: adaptive.reason,
      });
      this.#metrics?.increment("model.route.downgraded", { taskKind: options.taskKind, tier: adaptive.tier });
    }

    const achievedIndependence = !independenceRequested || chosen.provider.name !== options.excludeProvider;
    if (independenceRequested && !achievedIndependence) {
      this.#logger?.warn("Independent verification unavailable; falling back to a self-review", {
        taskKind: options.taskKind,
        excludeProvider: options.excludeProvider,
        chosenProvider: chosen.provider.name,
        detail: "Register a second model provider to enable independent verification.",
      });
    }

    return {
      chosen,
      fallbacks: adapted.slice(1),
      independenceRequested,
      independent: achievedIndependence,
      adaptive,
    };
  }

  #candidateFor(providerName: string, modelId: string): Candidate[] {
    const provider = this.#providers.get(providerName);
    if (!provider) return [];
    const descriptor = provider.models.find((model) => model.id === modelId);
    return descriptor ? [{ provider, descriptor }] : [];
  }

  /**
   * Every registered model, best first for this kind of work.
   *
   * Extraction and long-document work favour speed — they are checked later and
   * are run many times. Everything else favours reasoning, because it decides
   * what the research concludes. Ties break on model id so routing is
   * deterministic across processes.
   */
  #allCandidatesRanked(taskKind: ModelTaskKind): Candidate[] {
    const favourSpeed = taskKind === "extraction" || taskKind === "long_document" || taskKind === "embedding";
    const candidates: Candidate[] = [];
    for (const provider of this.#providers.values()) {
      for (const descriptor of provider.models) candidates.push({ provider, descriptor });
    }
    return candidates.sort((a, b) => {
      const primary = favourSpeed
        ? b.descriptor.speedTier - a.descriptor.speedTier
        : b.descriptor.reasoningTier - a.descriptor.reasoningTier;
      return primary || a.descriptor.id.localeCompare(b.descriptor.id);
    });
  }

  #candidatesForModel(modelId: string): Candidate[] {
    const found: Candidate[] = [];
    for (const provider of this.#providers.values()) {
      const descriptor = provider.models.find((model) => model.id === modelId);
      if (descriptor) found.push({ provider, descriptor });
    }
    return found;
  }

  #satisfies(candidate: Candidate, required: ReadonlySet<ModelCapability>, minInputTokens?: number): boolean {
    for (const capability of required) {
      if (!candidate.descriptor.capabilities.includes(capability)) return false;
    }
    if (minInputTokens !== undefined && candidate.descriptor.maxInputTokens < minInputTokens) return false;
    return true;
  }

  /* ---------- Circuit breaker ---------- */

  #isOpen(providerName: string): boolean {
    const state = this.#breakers.get(providerName);
    return state !== undefined && state.openUntil > this.#clock.now();
  }

  #recordSuccess(providerName: string): void {
    this.#breakers.delete(providerName);
  }

  #recordFailure(providerName: string): void {
    const state = this.#breakers.get(providerName) ?? { consecutiveFailures: 0, openUntil: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.#breakerThreshold) {
      state.openUntil = this.#clock.now() + this.#breakerCooldownMs;
      this.#logger?.warn("Provider taken out of rotation", {
        provider: providerName,
        consecutiveFailures: state.consecutiveFailures,
        cooldownMs: this.#breakerCooldownMs,
      });
    }
    this.#breakers.set(providerName, state);
  }

  /** Exposed so a health endpoint can report which providers are in cooldown. */
  breakerStatus(): Record<string, { open: boolean; consecutiveFailures: number }> {
    const status: Record<string, { open: boolean; consecutiveFailures: number }> = {};
    for (const name of this.#providers.keys()) {
      const state = this.#breakers.get(name);
      status[name] = {
        open: this.#isOpen(name),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
      };
    }
    return status;
  }

  /* ---------- Completion ---------- */

  async complete(request: CompleteRequest): Promise<RoutedResponse> {
    const decision = this.route(request);
    const chain = [decision.chosen, ...decision.fallbacks];

    let attempts = 0;
    let lastError: ResearchError | undefined;

    for (const candidate of chain) {
      for (let attempt = 1; attempt <= this.#retryPolicy.maxAttempts; attempt++) {
        request.signal?.throwIfAborted();
        attempts += 1;
        const startedAt = this.#clock.now();
        try {
          const response = await this.#callProvider(candidate, request, request.taskKind);
          this.#recordSuccess(candidate.provider.name);
          await this.#report(candidate, request.taskKind, response, attempts, null);
          return { response, decision, attempts };
        } catch (thrown) {
          const error = toResearchError(thrown);
          lastError = error;
          this.#recordFailure(candidate.provider.name);
          this.#metrics?.increment("model.call.failed", {
            provider: candidate.provider.name,
            model: candidate.descriptor.id,
            code: error.code,
          });
          await this.#reportFailure(candidate, request.taskKind, error, attempts, this.#clock.now() - startedAt);

          if (error.code === "cancelled") throw error;
          const lastAttemptOnThisModel = attempt >= this.#retryPolicy.maxAttempts;
          if (!error.retryable || lastAttemptOnThisModel) break;

          const delayMs = this.#backoff(attempt);
          this.#logger?.warn("Model call failed; retrying", {
            provider: candidate.provider.name, model: candidate.descriptor.id,
            attempt, delayMs, code: error.code, error: error.message,
          });
          await this.#clock.sleep(delayMs, request.signal);
        }
      }

      if (candidate !== chain.at(-1)) {
        this.#logger?.warn("Falling back to the next model", {
          from: `${candidate.provider.name}/${candidate.descriptor.id}`,
          taskKind: request.taskKind,
          reason: lastError?.message ?? "unknown",
        });
      }
    }

    throw lastError ?? err.provider(`Every candidate for "${request.taskKind}" failed without reporting an error.`);
  }

  #backoff(attempt: number): number {
    const policy = this.#retryPolicy;
    const exponential = Math.min(policy.initialDelayMs * policy.multiplier ** (attempt - 1), policy.maxDelayMs);
    if (policy.jitter <= 0) return Math.round(exponential);
    return Math.round(exponential * (1 - policy.jitter) + exponential * policy.jitter * this.#random());
  }

  async #callProvider(candidate: Candidate, request: CompleteRequest, taskKind: ModelTaskKind): Promise<ModelResponse> {
    const generateRequest: GenerateRequest = {
      model: candidate.descriptor.id,
      messages: request.messages,
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(request.maxOutputTokens === undefined
        ? { maxOutputTokens: candidate.descriptor.maxOutputTokens }
        : { maxOutputTokens: Math.min(request.maxOutputTokens, candidate.descriptor.maxOutputTokens) }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.stopSequences === undefined ? {} : { stopSequences: request.stopSequences }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      // Forwarded explicitly: this request is rebuilt field by field rather
      // than spread, so anything not named here is silently dropped before it
      // reaches the provider.
      ...(request.jsonSchema === undefined ? {} : { jsonSchema: request.jsonSchema }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };

    const run = async (): Promise<ModelResponse> => candidate.provider.generate(generateRequest);

    if (!this.#tracer) return run();
    return this.#tracer.withSpan("model_call", `${candidate.provider.name}/${candidate.descriptor.id}`, async (span) => {
      span.setAttributes({
        provider: candidate.provider.name,
        model: candidate.descriptor.id,
        taskKind,
        messageCount: request.messages.length,
      });
      const response = await run();
      span.setAttributes({
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: response.usage.costUsd,
        stopReason: response.stopReason,
      });
      return response;
    });
  }

  async #report(candidate: Candidate, taskKind: ModelTaskKind, response: ModelResponse, attempts: number, error: null): Promise<void> {
    void error;
    this.#metrics?.increment("model.call", { provider: candidate.provider.name, model: candidate.descriptor.id });
    this.#metrics?.observe("model.latency_ms", response.latencyMs, { model: candidate.descriptor.id });
    this.#metrics?.observe("model.cost_usd", response.usage.costUsd, { model: candidate.descriptor.id });
    await this.#onModelCall?.({
      provider: candidate.provider.name,
      model: candidate.descriptor.id,
      taskKind,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      costUsd: response.usage.costUsd,
      latencyMs: response.latencyMs,
      stopReason: response.stopReason,
      succeeded: true,
      errorMessage: null,
      attempts,
    });
  }

  async #reportFailure(candidate: Candidate, taskKind: ModelTaskKind, error: ResearchError, attempts: number, latencyMs: number): Promise<void> {
    // A failed call still costs latency and may have consumed tokens the
    // provider will bill for. Recording it keeps the ledger honest about what a
    // run actually did, rather than showing only the calls that worked.
    await this.#onModelCall?.({
      provider: candidate.provider.name,
      model: candidate.descriptor.id,
      taskKind,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      latencyMs,
      stopReason: null,
      succeeded: false,
      errorMessage: error.message,
      attempts,
    });
  }

  /* ---------- Structured output ---------- */

  /**
   * Completion validated against a schema.
   *
   * A model asked for JSON produces almost-JSON often enough that an agent
   * layer built on raw text would spend most of its code on parsing. When
   * validation fails the error is handed back to the model as a repair prompt —
   * models are good at fixing a named validation failure and poor at
   * spontaneously producing valid output for a complex schema.
   */
  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const maxRepairs = request.maxRepairAttempts ?? 2;
    const messages: ModelMessage[] = [...request.messages];

    let repairs = 0;
    let attempts = 0;
    let lastResponse: ModelResponse | undefined;
    let lastProblem: string | undefined;

    /*
     * The schema, in the form a provider can enforce.
     *
     * Asking for JSON in a prompt and validating afterwards works, but it makes
     * every structural mistake a round trip: the repair loop exists precisely
     * because models invent plausible alternative shapes. A provider that can
     * constrain decoding should be told the shape rather than asked for it.
     * Conversion is best effort — the validate-and-repair path is unchanged and
     * still the thing that guarantees correctness.
     */
    const jsonSchema = toJsonSchema(request.schema);

    for (;;) {
      const routed = await this.complete({
        ...request,
        messages,
        // Handed to providers that can constrain generation natively. Best
        // effort: a schema that cannot be expressed as JSON Schema simply
        // falls back to the prompt-and-validate path, which is what every
        // provider did before any of them supported this.
        ...(jsonSchema ? { jsonSchema } : {}),
        requiredCapabilities: [...(request.requiredCapabilities ?? []), "structured_output"],
      });
      lastResponse = routed.response;
      attempts += routed.attempts;

      const parsed = this.#parseAndValidate(request.schema, routed.response.text);
      if (parsed.ok) {
        return { value: parsed.value, response: routed.response, decision: routed.decision, attempts, repairs };
      }

      lastProblem = parsed.problem;
      if (repairs >= maxRepairs) break;

      repairs += 1;
      this.#metrics?.increment("model.structured.repair", { model: routed.response.model });
      this.#logger?.warn("Structured output failed validation; asking the model to repair it", {
        model: routed.response.model, repair: repairs, problem: lastProblem,
      });
      messages.push(
        { role: "assistant", content: routed.response.text },
        {
          role: "user",
          content:
            `That response could not be used: ${lastProblem}\n\n` +
            "Reply with the corrected JSON object only — no prose, no code fence, no explanation.",
        },
      );
    }

    throw err.validation(
      `Model output failed schema validation after ${repairs} repair attempt(s): ${lastProblem ?? "no output was produced"}`,
      {
        model: lastResponse?.model ?? "unknown",
        provider: lastResponse?.provider ?? "unknown",
        preview: (lastResponse?.text ?? "").slice(0, 500),
      },
    );
  }

  #parseAndValidate<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; problem: string } {
    let candidate: unknown;
    try {
      candidate = extractJsonObject(text);
    } catch (error) {
      return {
        ok: false,
        problem: isResearchError(error) ? error.message : "the response did not contain a JSON object",
      };
    }

    const result = schema.safeParse(candidate);
    if (result.success) return { ok: true, value: result.data };

    const problems = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problem: `schema validation failed — ${problems}` };
  }

  /* ---------- Embeddings ---------- */

  async embed(inputs: readonly string[], options: { model?: string; signal?: AbortSignal } = {}) {
    for (const provider of this.#providers.values()) {
      if (!provider.embed) continue;
      const descriptor = options.model
        ? provider.models.find((model) => model.id === options.model)
        : provider.models.find((model) => model.capabilities.includes("embedding"));
      if (!descriptor) continue;
      return provider.embed({
        model: descriptor.id,
        inputs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    throw err.unsupported(
      "No registered provider offers embeddings. Retrieval falls back to lexical search until an embedding provider is configured.",
    );
  }
}
