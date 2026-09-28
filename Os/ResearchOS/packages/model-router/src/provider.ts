/**
 * The ModelProvider port.
 *
 * Everything above this line talks about *a model*, never about Anthropic,
 * OpenAI or anyone else. An adapter's whole job is to translate between this
 * shape and one vendor's SDK; if vendor-specific concepts leak upward, the
 * abstraction has failed and swapping providers stops being possible.
 *
 * The port is intentionally small. `generate` is required; streaming and
 * embedding are optional because not every provider offers them, and the router
 * checks for them rather than assuming.
 */
import type {
  EmbeddingResponse, ModelDescriptor, ModelMessage, ModelResponse, ModelTaskKind,
} from "@research-os/contracts";

/** A tool offered to the model, described in the model's own terms. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's input. */
  readonly inputSchema: Record<string, unknown>;
}

export interface GenerateRequest {
  readonly model: string;
  /** System prompt. Separate from messages because providers treat it separately. */
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly tools?: readonly ModelToolDefinition[];
  /**
   * Requests JSON output matching this schema where the provider supports it
   * natively. The router still validates the result, because "supports" is not
   * "guarantees".
   */
  readonly jsonSchema?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface EmbedRequest {
  readonly model: string;
  readonly inputs: readonly string[];
  readonly signal?: AbortSignal;
}

/** One incremental piece of a streamed response. */
export type ModelStreamChunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_call"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "done"; readonly response: ModelResponse };

export interface ModelProvider {
  /** Stable name used in routing rules, traces and the model-call ledger. */
  readonly name: string;
  /** Models this provider can serve, with capabilities, limits and pricing. */
  readonly models: readonly ModelDescriptor[];

  generate(request: GenerateRequest): Promise<ModelResponse>;
  stream?(request: GenerateRequest): AsyncIterable<ModelStreamChunk>;
  embed?(request: EmbedRequest): Promise<EmbeddingResponse>;

  /** Cheap liveness probe. The router routes away from an unhealthy provider. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * What the router reports about one completed call.
 *
 * The router does not write to the database — persistence is a sibling layer,
 * not something a router should know about. It hands this record to whatever
 * sink the composition root supplies, which in practice is
 * `RunRepository.recordModelCall`.
 */
export interface ModelCallRecord {
  readonly provider: string;
  readonly model: string;
  readonly taskKind: ModelTaskKind | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly stopReason: string | null;
  readonly succeeded: boolean;
  readonly errorMessage: string | null;
  readonly attempts: number;
}

export type ModelCallSink = (record: ModelCallRecord) => void | Promise<void>;
