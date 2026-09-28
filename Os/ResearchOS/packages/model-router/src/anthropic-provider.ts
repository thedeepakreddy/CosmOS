/**
 * Anthropic adapter.
 *
 * The only file in ResearchOS that knows Anthropic exists. Everything it does is
 * translation: ResearchOS's `GenerateRequest` in, `ModelResponse` out, with the
 * SDK's shapes confined to this module.
 *
 * Two translations are load-bearing rather than mechanical:
 *
 *   - **Errors become `ResearchError`s with a correct `retryable` flag.** The
 *     orchestrator decides between retrying and failing a research task from
 *     that flag alone, so misclassifying a 429 as permanent (or a 400 as
 *     transient) turns into wasted spend or a lost run.
 *   - **Cost is computed here, from the descriptor's configured rates and the
 *     provider's reported token counts.** Budget enforcement reads it, so it is
 *     calculated once at the point where both numbers are known.
 *
 * The SDK is imported lazily so that installing ResearchOS, running its tests,
 * or deploying a scripted-provider-only configuration never requires the
 * package to be present or an API key to exist.
 */
import type { ModelDescriptor, ModelResponse, ModelStopReason, ModelToolCall } from "@research-os/contracts";
import { computeCostUsd } from "@research-os/observability";
import { err, readOptionalString, systemClock, type Clock, type EnvSource } from "@research-os/shared";
import { ANTHROPIC_MODEL_SPECS, describeModels, pricingFromEnv, type ModelSpec, type PricingTable } from "./catalog.ts";
import type { GenerateRequest, ModelProvider } from "./provider.ts";

export const ANTHROPIC_PROVIDER_NAME = "anthropic";

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly pricing: PricingTable;
  readonly specs?: readonly ModelSpec[];
  readonly baseUrl?: string;
  readonly clock?: Clock;
  /** Per-request ceiling. The SDK's own retries are disabled; the router owns retry. */
  readonly timeoutMs?: number;
}

/* Structural types for the slice of the SDK used here, so it stays optional. */
interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

interface AnthropicMessage {
  content: AnthropicBlock[];
  stop_reason: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

interface AnthropicClient {
  messages: { create(body: Record<string, unknown>, options?: Record<string, unknown>): Promise<AnthropicMessage> };
}

/** Anthropic's stop reasons, mapped onto the contract's vocabulary. */
function toStopReason(raw: string | null): ModelStopReason {
  switch (raw) {
    case "end_turn": return "end_turn";
    case "max_tokens": return "max_tokens";
    case "stop_sequence": return "stop_sequence";
    case "tool_use": return "tool_use";
    case "refusal": return "refusal";
    default: return "end_turn";
  }
}

/**
 * Classifies a provider failure.
 *
 * Retryable: rate limits, overload, timeouts, 5xx, and transport errors.
 * Not retryable: authentication, permission and malformed-request failures —
 * retrying those burns the budget to arrive at the same answer.
 */
function toProviderError(error: unknown): ReturnType<typeof err.provider> {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 401 || status === 403) {
    return err.provider(`Anthropic rejected the credentials: ${message}`, { retryable: false, cause: error, details: { status } });
  }
  if (status === 400 || status === 404 || status === 422) {
    return err.provider(`Anthropic rejected the request: ${message}`, { retryable: false, cause: error, details: { status } });
  }
  if (status === 429 || status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return err.provider(`Anthropic is temporarily unavailable (${status}): ${message}`, { retryable: true, cause: error, details: { status } });
  }
  // No status: a transport-level failure. Transient until proven otherwise.
  return err.provider(`Anthropic request failed: ${message}`, { retryable: status === undefined, cause: error, ...(status === undefined ? {} : { details: { status } }) });
}

export class AnthropicProvider implements ModelProvider {
  readonly name = ANTHROPIC_PROVIDER_NAME;
  readonly models: readonly ModelDescriptor[];

  readonly #apiKey: string;
  readonly #baseUrl: string | undefined;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  #client: AnthropicClient | undefined;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw err.validation("AnthropicProvider requires an API key. Set ANTHROPIC_API_KEY.");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    // Throws here, at construction, if a model has no configured price —
    // before a run has started and before anything has been billed.
    this.models = describeModels(this.name, options.specs ?? ANTHROPIC_MODEL_SPECS, options.pricing);
  }

  async #ensureClient(): Promise<AnthropicClient> {
    if (this.#client) return this.#client;
    // Cast through `unknown`: the SDK's real signatures are far richer than the
    // slice used here, and the narrow structural type above is the point — it
    // is what keeps the rest of the file honest about how much of the SDK this
    // adapter actually depends on. `postgres-database.ts` does the same for `pg`.
    let module: { default?: new (config: unknown) => AnthropicClient };
    try {
      module = (await import("@anthropic-ai/sdk")) as unknown as typeof module;
    } catch (error) {
      throw err.provider(
        "The @anthropic-ai/sdk package is not installed, so the Anthropic provider cannot be used.",
        { retryable: false, cause: error },
      );
    }
    const Anthropic = module.default;
    if (!Anthropic) throw err.provider("@anthropic-ai/sdk did not export a client constructor.", { retryable: false });

    this.#client = new Anthropic({
      apiKey: this.#apiKey,
      ...(this.#baseUrl ? { baseURL: this.#baseUrl } : {}),
      // The router owns retry: it also handles falling back to another model,
      // and two independent retry loops would multiply into a long stall that
      // neither layer can see the shape of.
      maxRetries: 0,
      timeout: this.#timeoutMs,
    });
    return this.#client;
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    const descriptor = this.models.find((model) => model.id === request.model);
    if (!descriptor) {
      throw err.validation(`Model "${request.model}" is not in the Anthropic catalog.`, { model: request.model });
    }

    const client = await this.#ensureClient();
    const startedAt = this.#clock.now();

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: Math.min(request.maxOutputTokens ?? descriptor.maxOutputTokens, descriptor.maxOutputTokens),
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (request.system !== undefined) body["system"] = request.system;
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.stopSequences?.length) body["stop_sequences"] = [...request.stopSequences];
    if (request.tools?.length) {
      body["tools"] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    let message: AnthropicMessage;
    try {
      message = await client.messages.create(
        body,
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (error) {
      if (request.signal?.aborted) throw err.cancelled("Model call cancelled");
      throw toProviderError(error);
    }

    const latencyMs = this.#clock.now() - startedAt;
    const text = message.content
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls: ModelToolCall[] = message.content
      .filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cachedInputTokens = message.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0;

    return {
      text,
      toolCalls,
      stopReason: toStopReason(message.stop_reason),
      model: message.model || request.model,
      provider: this.name,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        costUsd: computeCostUsd({ inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens }, descriptor),
      },
      latencyMs,
      refusalCategory: message.stop_reason === "refusal" ? "provider_refusal" : null,
    };
  }

  /**
   * A one-token completion against the cheapest configured model.
   *
   * Deliberately a real call: an API key can be present and still be revoked,
   * out of credit, or scoped to the wrong organisation, and none of that is
   * visible without asking the provider.
   */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const cheapest = [...this.models].sort((a, b) => a.inputCostPerMTokUsd - b.inputCostPerMTokUsd)[0];
    if (!cheapest) return { ok: false, detail: "no models configured" };
    try {
      await this.generate({
        model: cheapest.id,
        messages: [{ role: "user", content: "ok" }],
        maxOutputTokens: 1,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Builds the provider from the environment, or returns `undefined` when no key
 * is set.
 *
 * Returning `undefined` rather than throwing is deliberate: a developer running
 * the test suite or a scripted-provider configuration has no key, and that is a
 * valid setup, not an error. The composition root reports which providers came
 * up and fails only if none did.
 */
export function anthropicProviderFromEnv(
  env: EnvSource = process.env,
  options: { clock?: Clock } = {},
): AnthropicProvider | undefined {
  const apiKey = readOptionalString(env, "ANTHROPIC_API_KEY");
  if (!apiKey) return undefined;
  const baseUrl = readOptionalString(env, "ANTHROPIC_BASE_URL");
  return new AnthropicProvider({
    apiKey,
    pricing: pricingFromEnv(env),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
