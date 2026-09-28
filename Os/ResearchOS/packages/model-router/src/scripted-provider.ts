/**
 * A deterministic ModelProvider, for tests and offline development.
 *
 * **This is a test double and must never serve production traffic.** It does not
 * reason; it replays a script. It exists so that orchestration, agent wiring,
 * retry behaviour and budget accounting can be tested exactly — a real model
 * makes those tests slow, expensive and non-deterministic, which in practice
 * means they do not get written.
 *
 * It follows the same convention as `RecordingEventBus`: named unambiguously,
 * living in `src` only so other packages' tests can import it.
 *
 * Token counts come from the same estimator the rest of ResearchOS uses and cost
 * from the descriptor's real rates, so a test asserting that a run stayed inside
 * its budget is exercising the actual accounting path rather than a stub.
 */
import type {
  EmbeddingResponse, ModelDescriptor, ModelResponse, ModelStopReason, ModelToolCall,
} from "@research-os/contracts";
import { computeCostUsd } from "@research-os/observability";
import { err, estimateTokens, type ResearchError } from "@research-os/shared";
import type { EmbedRequest, GenerateRequest, ModelProvider } from "./provider.ts";

export interface ScriptedTurn {
  /**
   * Restricts this turn to matching requests. A string matches when it appears
   * in the last user message. Unmatched turns are consumed in order.
   */
  readonly when?: string | RegExp | ((request: GenerateRequest) => boolean);
  readonly text?: string;
  /** Convenience for structured-output tests: serialised as the response text. */
  readonly json?: unknown;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly stopReason?: ModelStopReason;
  /** Thrown instead of returning, to exercise retry and fallback paths. */
  readonly error?: ResearchError;
  readonly latencyMs?: number;
  /** Replays indefinitely instead of being consumed once. */
  readonly repeat?: boolean;
}

export interface ScriptedModelProviderOptions {
  readonly name?: string;
  readonly models: readonly ModelDescriptor[];
  readonly script?: readonly ScriptedTurn[];
  /** Returned when the script is exhausted. Without one, exhaustion throws. */
  readonly fallbackText?: string;
  readonly healthy?: boolean;
  /** Deterministic embedding dimensions, when embeddings are scripted. */
  readonly embeddingDimensions?: number;
}

export class ScriptedModelProvider implements ModelProvider {
  readonly name: string;
  readonly models: readonly ModelDescriptor[];
  /** Every request received, in order. Assert on prompts with this. */
  readonly requests: GenerateRequest[] = [];

  #queue: ScriptedTurn[];
  #healthy: boolean;
  readonly #fallbackText: string | undefined;
  readonly #embeddingDimensions: number;

  constructor(options: ScriptedModelProviderOptions) {
    if (options.models.length === 0) {
      throw err.validation("ScriptedModelProvider needs at least one model descriptor.");
    }
    this.name = options.name ?? "scripted";
    this.models = options.models;
    this.#queue = [...(options.script ?? [])];
    this.#healthy = options.healthy ?? true;
    this.#fallbackText = options.fallbackText;
    this.#embeddingDimensions = options.embeddingDimensions ?? 8;
  }

  /** Replaces the remaining script mid-test. */
  setScript(script: readonly ScriptedTurn[]): void {
    this.#queue = [...script];
  }

  setHealthy(healthy: boolean): void {
    this.#healthy = healthy;
  }

  get remainingTurns(): number {
    return this.#queue.length;
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    this.requests.push(request);

    const descriptor = this.models.find((model) => model.id === request.model);
    if (!descriptor) {
      throw err.validation(`ScriptedModelProvider "${this.name}" has no model "${request.model}".`, {
        model: request.model,
      });
    }

    const turn = this.#nextTurn(request);
    if (turn?.error) throw turn.error;

    const text = turn?.json !== undefined ? JSON.stringify(turn.json) : (turn?.text ?? this.#fallbackText);
    if (text === undefined) {
      throw err.provider(
        `ScriptedModelProvider "${this.name}" ran out of script. Add a turn, or set fallbackText.`,
        { retryable: false, details: { model: request.model, requestCount: this.requests.length } },
      );
    }

    const promptText = [request.system ?? "", ...request.messages.map((message) => message.content)].join("\n");
    const inputTokens = estimateTokens(promptText);
    const outputTokens = estimateTokens(text);

    return {
      text,
      toolCalls: [...(turn?.toolCalls ?? [])],
      stopReason: turn?.stopReason ?? (turn?.toolCalls?.length ? "tool_use" : "end_turn"),
      model: descriptor.id,
      provider: this.name,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: computeCostUsd({ inputTokens, outputTokens }, descriptor),
      },
      latencyMs: turn?.latencyMs ?? 1,
      refusalCategory: null,
    };
  }

  async embed(request: EmbedRequest): Promise<EmbeddingResponse> {
    const descriptor = this.models.find((model) => model.id === request.model);
    if (!descriptor) throw err.validation(`No model "${request.model}".`, { model: request.model });

    // A stable hash-derived vector: the same text always embeds identically, so
    // similarity assertions in retrieval tests are reproducible.
    const vectors = request.inputs.map((input) => {
      const vector = new Array<number>(this.#embeddingDimensions).fill(0);
      for (let i = 0; i < input.length; i++) {
        const index = input.charCodeAt(i) % this.#embeddingDimensions;
        vector[index] = (vector[index] ?? 0) + 1;
      }
      const magnitude = Math.hypot(...vector) || 1;
      return vector.map((value) => value / magnitude);
    });

    const inputTokens = request.inputs.reduce((total, input) => total + estimateTokens(input), 0);
    return {
      vectors,
      model: descriptor.id,
      provider: this.name,
      dimensions: this.#embeddingDimensions,
      usage: {
        inputTokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: computeCostUsd({ inputTokens, outputTokens: 0 }, descriptor),
      },
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return this.#healthy ? { ok: true } : { ok: false, detail: "scripted as unhealthy" };
  }

  #nextTurn(request: GenerateRequest): ScriptedTurn | undefined {
    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";

    const index = this.#queue.findIndex((turn) => {
      if (turn.when === undefined) return true;
      if (typeof turn.when === "string") return lastUserMessage.includes(turn.when);
      if (turn.when instanceof RegExp) return turn.when.test(lastUserMessage);
      return turn.when(request);
    });
    if (index === -1) return undefined;

    const turn = this.#queue[index];
    if (!turn?.repeat) this.#queue.splice(index, 1);
    return turn;
  }
}

/** Descriptors for a scripted provider, priced so cost assertions are meaningful. */
export function scriptedModels(
  ids: readonly string[] = ["scripted-model"],
  overrides: Partial<ModelDescriptor> = {},
): ModelDescriptor[] {
  return ids.map((id) => ({
    id,
    provider: "scripted",
    displayName: id,
    capabilities: ["text", "tool_use", "structured_output", "streaming", "long_context"],
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    inputCostPerMTokUsd: 1,
    outputCostPerMTokUsd: 5,
    reasoningTier: 0.5,
    speedTier: 0.5,
    ...overrides,
  }));
}
