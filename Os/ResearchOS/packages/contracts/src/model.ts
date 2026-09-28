import { z } from "zod";

/**
 * Model provider contracts.
 *
 * These describe what ResearchOS needs from a language model, in terms that no
 * single vendor's SDK dictates. An adapter's job is to translate between this
 * shape and its provider; nothing above the adapter layer knows which vendor is
 * serving a request.
 */

export const MODEL_CAPABILITIES = [
  "text",
  "vision",
  "tool_use",
  "structured_output",
  "streaming",
  "long_context",
  "embedding",
  "reasoning",
] as const;
export const ModelCapability = z.enum(MODEL_CAPABILITIES);
export type ModelCapability = z.infer<typeof ModelCapability>;

/**
 * Task kinds the router dispatches on. Naming the *kind of work* rather than a
 * model tier is what lets routing policy change without touching call sites.
 */
export const MODEL_TASK_KINDS = [
  "planning",
  "extraction",
  "analysis",
  "critique",
  "judgment",
  "coding",
  "long_document",
  "vision",
  "synthesis",
  "embedding",
  "verification",
] as const;
export const ModelTaskKind = z.enum(MODEL_TASK_KINDS);
export type ModelTaskKind = z.infer<typeof ModelTaskKind>;

export const ModelMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ModelUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** Computed from the provider's published rates at call time. */
  costUsd: z.number().nonnegative(),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ModelStopReason = z.enum([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "refusal",
  "error",
]);
export type ModelStopReason = z.infer<typeof ModelStopReason>;

export const ModelToolCall = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ModelToolCall = z.infer<typeof ModelToolCall>;

export const ModelResponse = z.object({
  text: z.string(),
  toolCalls: z.array(ModelToolCall).default([]),
  stopReason: ModelStopReason,
  model: z.string(),
  provider: z.string(),
  usage: ModelUsage,
  latencyMs: z.number().int().nonnegative(),
  /** Populated when stopReason is `refusal`. */
  refusalCategory: z.string().nullable().default(null),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export const EmbeddingResponse = z.object({
  vectors: z.array(z.array(z.number())),
  model: z.string(),
  provider: z.string(),
  dimensions: z.number().int().positive(),
  usage: ModelUsage,
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponse>;

/** Per-model pricing and limits, used for pre-flight budget checks and cost accounting. */
export const ModelDescriptor = z.object({
  id: z.string(),
  provider: z.string(),
  displayName: z.string(),
  capabilities: z.array(ModelCapability),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputCostPerMTokUsd: z.number().nonnegative(),
  outputCostPerMTokUsd: z.number().nonnegative(),
  cachedInputCostPerMTokUsd: z.number().nonnegative().optional(),
  /** Relative reasoning strength in [0,1]; used only to break ties in routing. */
  reasoningTier: z.number().min(0).max(1).default(0.5),
  /** Relative speed in [0,1]. */
  speedTier: z.number().min(0).max(1).default(0.5),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

/**
 * A routing rule. The first rule whose task kind matches, whose required
 * capabilities are satisfied and whose provider is healthy wins.
 */
export const ModelRoutingRule = z.object({
  taskKind: ModelTaskKind,
  /** Ordered preference. Later entries are fallbacks. */
  candidates: z.array(z.object({ provider: z.string(), model: z.string() })).min(1),
  requiredCapabilities: z.array(ModelCapability).default([]),
  /**
   * When true, the router must pick a provider different from the one that
   * produced the artifact under review — the mechanism behind independent
   * verification.
   */
  requireDistinctProvider: z.boolean().default(false),
});
export type ModelRoutingRule = z.infer<typeof ModelRoutingRule>;
