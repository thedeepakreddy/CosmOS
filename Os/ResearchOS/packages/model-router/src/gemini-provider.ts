/**
 * The Google Gemini adapter.
 *
 * Written against the Generative Language REST API with `fetch` rather than a
 * vendor SDK. That is a deliberate difference from `AnthropicProvider`: the
 * surface this port needs is four fields of one endpoint, an SDK would be a new
 * external dependency in a layer-3 package for no gain, and `fetch` is a
 * platform global. Nothing above this file learns that either choice was made.
 *
 * Two mappings deserve naming, because they are where a vendor's shape would
 * otherwise leak upward:
 *
 *   - Gemini calls the assistant `model`, the contract calls it `assistant`.
 *   - Gemini reports a `SAFETY` / `PROHIBITED_CONTENT` finish reason where the
 *     contract has `refusal`. Mapping those to `end_turn` would present a
 *     blocked response as a complete one, and a research run would treat an
 *     empty answer as a finding.
 */
import type {
  EmbeddingResponse, ModelDescriptor, ModelResponse, ModelStopReason, ModelToolCall,
} from "@research-os/contracts";
import { computeCostUsd } from "@research-os/observability";
import { err, readOptionalString, systemClock, type Clock, type EnvSource } from "@research-os/shared";
import { GEMINI_MODEL_SPECS, describeModels, pricingFromEnv, type ModelSpec, type PricingTable } from "./catalog.ts";
import type { EmbedRequest, GenerateRequest, ModelProvider } from "./provider.ts";

export const GEMINI_PROVIDER_NAME = "gemini";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/* Structural types for the slice of the REST response this adapter reads. */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: unknown };
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}
interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}
interface GeminiEmbedResponse {
  embeddings?: { values?: number[] }[];
}

/** Gemini's finish reasons, mapped onto the contract's vocabulary. */
function toStopReason(raw: string | undefined): ModelStopReason {
  switch (raw) {
    case "STOP": return "end_turn";
    case "MAX_TOKENS": return "max_tokens";
    case "STOP_SEQUENCE": return "stop_sequence";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    case "MALFORMED_FUNCTION_CALL":
    case "OTHER":
      return "error";
    default: return "end_turn";
  }
}

/**
 * Classifies a provider failure.
 *
 * Same policy as the Anthropic adapter, because the policy belongs to
 * ResearchOS rather than to a vendor: authentication, permission and
 * malformed-request failures are final; rate limits, overload and transport
 * failures are worth another attempt.
 */
function toProviderError(status: number | undefined, message: string, cause?: unknown): ReturnType<typeof err.provider> {
  const details = status === undefined ? {} : { details: { status } };
  if (status === 401 || status === 403) {
    return err.provider(`Gemini rejected the credentials: ${message}`, { retryable: false, cause, ...details });
  }
  if (status === 400 || status === 404 || status === 422) {
    return err.provider(`Gemini rejected the request: ${message}`, { retryable: false, cause, ...details });
  }
  if (status === 429 || status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return err.provider(`Gemini is temporarily unavailable (${status}): ${message}`, { retryable: true, cause, ...details });
  }
  // No status: a transport-level failure. Transient until proven otherwise.
  return err.provider(`Gemini request failed: ${message}`, { retryable: status === undefined, cause, ...details });
}

/**
 * JSON Schema, narrowed to what Gemini's `responseSchema` accepts.
 *
 * Google's dialect is a subset: metadata keywords and composition constructs
 * are rejected outright with a 400, and `additionalProperties` in particular is
 * emitted by most generators. Stripping them is better than not sending a
 * schema at all, because what survives still constrains the shape — and the
 * router validates the result regardless, so a weakened constraint costs a
 * repair round at worst, never a wrong answer accepted.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  // Metadata and composition: rejected outright.
  "$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties",
  "allOf", "oneOf", "not", "const", "examples", "default", "patternProperties",
  // Value constraints. Gemini rejects the whole request rather than ignoring
  // them, and they are measured — a schema carrying `minimum`/`maxLength`
  // returns 400 INVALID_ARGUMENT while the same schema without them is
  // accepted and answers in the right shape. Dropping them costs nothing that
  // matters: they constrain decoding only, and `structured()` still validates
  // the result against the real zod schema, which is what actually enforces
  // them.
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
]);

function narrowSchemaForGemini(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(narrowSchemaForGemini);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = narrowSchemaForGemini(child);
  }
  return out;
}

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly pricing: PricingTable;
  readonly specs?: readonly ModelSpec[];
  readonly baseUrl?: string;
  readonly clock?: Clock;
  /** Per-request ceiling. The router owns retry, so none is attempted here. */
  readonly timeoutMs?: number;
  /** Injectable so the adapter can be exercised without a network. */
  readonly fetchImpl?: typeof fetch;
}

export class GeminiProvider implements ModelProvider {
  readonly name = GEMINI_PROVIDER_NAME;
  readonly models: readonly ModelDescriptor[];

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) {
      throw err.validation("GeminiProvider requires an API key. Set GEMINI_API_KEY.");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    // Throws here, at construction, if a model has no configured price —
    // before a run has started and before anything has been billed.
    this.models = describeModels(this.name, options.specs ?? GEMINI_MODEL_SPECS, options.pricing);
  }

  /**
   * One request to the REST API.
   *
   * The key travels in a header, never in the query string: a URL ends up in
   * proxy logs, browser history and error reports, and a credential must not.
   */
  async #post<T>(path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw err.cancelled("Model call cancelled");
      if (controller.signal.aborted) throw toProviderError(408, `no response within ${this.#timeoutMs}ms`, error);
      throw toProviderError(undefined, error instanceof Error ? error.message : String(error), error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const text = await response.text();
    if (!response.ok) {
      // Google returns `{ error: { message } }`; the raw body is the fallback so
      // an unexpected shape still reaches the operator rather than becoming
      // "undefined".
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch { /* not JSON; the raw body is already the best available detail */ }
      throw toProviderError(response.status, detail);
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw toProviderError(response.status, "the response body was not valid JSON", error);
    }
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    const descriptor = this.models.find((model) => model.id === request.model);
    if (!descriptor) {
      throw err.validation(`Model "${request.model}" is not in the Gemini catalog.`, { model: request.model });
    }

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: Math.min(request.maxOutputTokens ?? descriptor.maxOutputTokens, descriptor.maxOutputTokens),
    };
    if (request.temperature !== undefined) generationConfig["temperature"] = request.temperature;
    if (request.stopSequences?.length) generationConfig["stopSequences"] = [...request.stopSequences];
    if (request.jsonSchema) {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseSchema"] = narrowSchemaForGemini(request.jsonSchema);
    }

    const body: Record<string, unknown> = {
      contents: request.messages.map((message) => ({
        // Gemini's name for the assistant turn.
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
      generationConfig,
    };
    if (request.system !== undefined) body["systemInstruction"] = { parts: [{ text: request.system }] };
    if (request.tools?.length) {
      body["tools"] = [{
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      }];
    }

    const startedAt = this.#clock.now();
    const payload = await this.#post<GeminiGenerateResponse>(
      `/models/${encodeURIComponent(request.model)}:generateContent`,
      body,
      request.signal,
    );
    const latencyMs = this.#clock.now() - startedAt;

    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("");
    const toolCalls: ModelToolCall[] = parts
      .filter((part): part is GeminiPart & { functionCall: { name: string; args?: unknown } } => part.functionCall !== undefined)
      .map((part, index) => ({
        // Gemini does not issue tool-call ids; one is synthesised so the rest of
        // ResearchOS can correlate a call with its result the same way for every
        // provider.
        id: `${request.model}-call-${index}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      }));

    /*
     * A prompt blocked before generation returns no candidate at all. That is a
     * refusal, and it must be reported as one: an empty string with a normal
     * stop reason would be read downstream as "the model had nothing to say",
     * which is a different and much more damaging claim.
     */
    const blockReason = payload.promptFeedback?.blockReason;
    const stopReason: ModelStopReason = blockReason ? "refusal" : toStopReason(candidate?.finishReason);

    const inputTokens = payload.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = payload.usageMetadata?.candidatesTokenCount ?? 0;
    const cachedInputTokens = payload.usageMetadata?.cachedContentTokenCount ?? 0;

    return {
      text,
      toolCalls,
      stopReason,
      model: request.model,
      provider: this.name,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens: 0,
        costUsd: computeCostUsd({ inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens: 0 }, descriptor),
      },
      latencyMs,
      refusalCategory: stopReason === "refusal" ? (blockReason ?? candidate?.finishReason ?? "provider_refusal") : null,
    };
  }

  /**
   * Embeddings, which Gemini offers and Anthropic does not.
   *
   * Worth implementing rather than leaving optional: with an embedding model
   * registered, retrieval stops being lexical-only, and the engine stops
   * declaring that gap at startup.
   */
  async embed(request: EmbedRequest): Promise<EmbeddingResponse> {
    const descriptor = this.models.find((model) => model.id === request.model);
    if (!descriptor) {
      throw err.validation(`Model "${request.model}" is not in the Gemini catalog.`, { model: request.model });
    }
    if (!descriptor.capabilities.includes("embedding")) {
      throw err.validation(`Model "${request.model}" is not an embedding model.`, { model: request.model });
    }

    const payload = await this.#post<GeminiEmbedResponse>(
      `/models/${encodeURIComponent(request.model)}:batchEmbedContents`,
      {
        requests: request.inputs.map((input) => ({
          model: `models/${request.model}`,
          content: { parts: [{ text: input }] },
        })),
      },
      request.signal,
    );

    const vectors = (payload.embeddings ?? []).map((embedding) => embedding.values ?? []);
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions === 0) {
      throw err.provider("Gemini returned no embedding vectors.", { retryable: false });
    }

    return {
      vectors,
      model: request.model,
      provider: this.name,
      dimensions,
      // The embedding endpoint reports no token usage, and a guessed number in
      // the cost ledger would be worse than a zero that is visibly a zero.
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    };
  }

  /**
   * A one-token completion against the cheapest configured model.
   *
   * Deliberately a real call: a key can be present and still be revoked, out of
   * quota, or missing the Generative Language API permission, and none of that
   * is visible without asking.
   */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const cheapest = [...this.models]
      .filter((model) => !model.capabilities.includes("embedding"))
      .sort((a, b) => a.inputCostPerMTokUsd - b.inputCostPerMTokUsd)[0];
    if (!cheapest) return { ok: false, detail: "no generative models configured" };
    try {
      await this.generate({ model: cheapest.id, messages: [{ role: "user", content: "ok" }], maxOutputTokens: 1 });
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
 * `GEMINI_API_KEY` is checked before `GOOGLE_API_KEY` because the second is
 * shared with other Google services and is the more likely to be present for an
 * unrelated reason.
 */
export function geminiProviderFromEnv(
  env: EnvSource = process.env,
  options: { clock?: Clock } = {},
): GeminiProvider | undefined {
  const apiKey = readOptionalString(env, "GEMINI_API_KEY") ?? readOptionalString(env, "GOOGLE_API_KEY");
  if (!apiKey) return undefined;
  const baseUrl = readOptionalString(env, "GEMINI_BASE_URL");
  return new GeminiProvider({
    apiKey,
    pricing: pricingFromEnv(env),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
