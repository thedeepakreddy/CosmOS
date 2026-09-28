/**
 * The model catalog, and why prices are not hard-coded in it.
 *
 * Capabilities and context limits are properties of a model, so they live here.
 * **Prices are not.** Published rates change, and a stale rate compiled into the
 * source does not fail — it silently mis-bills every research run, and budget
 * enforcement reads those numbers to decide when to stop. A run that believes it
 * has spent $2 when it has spent $20 is a worse failure than a run that refuses
 * to start.
 *
 * So pricing is configuration. Supply it when constructing a provider, or set
 * `RESEARCH_OS_MODEL_PRICING`; a model with no configured price is rejected at
 * construction, naming the model and the variable to set, rather than being
 * billed at zero.
 *
 * Context limits default to conservative floors. Under-stating a limit costs a
 * little extra chunking; over-stating it produces provider errors mid-run, so
 * the safe direction is down. Raise them per model in configuration once the
 * deployed model's real limits are confirmed.
 */
import type { ModelCapability, ModelDescriptor } from "@research-os/contracts";
import { err, readOptionalString, safeJsonParse, type EnvSource } from "@research-os/shared";

/** Everything about a model except what it costs. */
export interface ModelSpec {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ModelCapability[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Relative reasoning strength in [0,1]. Only ever used to break routing ties. */
  readonly reasoningTier: number;
  readonly speedTier: number;
}

export interface ModelPricing {
  readonly inputCostPerMTokUsd: number;
  readonly outputCostPerMTokUsd: number;
  readonly cachedInputCostPerMTokUsd?: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

const TEXT_AGENT_CAPABILITIES: readonly ModelCapability[] = [
  "text", "tool_use", "structured_output", "streaming", "long_context", "vision",
];

/**
 * Anthropic models ResearchOS knows how to route to.
 *
 * Adding one here does not make it available — a provider must still be
 * configured with its price.
 */
export const ANTHROPIC_MODEL_SPECS: readonly ModelSpec[] = [
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    capabilities: [...TEXT_AGENT_CAPABILITIES, "reasoning"],
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    reasoningTier: 1,
    speedTier: 0.4,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    capabilities: [...TEXT_AGENT_CAPABILITIES, "reasoning"],
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    reasoningTier: 0.85,
    speedTier: 0.7,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    capabilities: TEXT_AGENT_CAPABILITIES,
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    reasoningTier: 0.55,
    speedTier: 1,
  },
];

/**
 * Gemini models ResearchOS knows how to route to.
 *
 * **Every id and limit here was read from the live `ListModels` endpoint, not
 * from documentation.** An earlier version of this list named the 2.5 series
 * from memory; those ids still appear in `ListModels` but `generateContent`
 * rejects them with "no longer available to new users", so a run failed per
 * task, mid-flight, rather than at startup. Being listed is not being callable,
 * and only a real call proves the difference.
 *
 * The two `-latest` aliases are preferred deliberately: they track whatever
 * Google currently serves, so this list does not go stale the next time a
 * generation is retired.
 *
 * **No pro-tier model is listed.** `gemini-pro-latest` is callable only with
 * billing enabled; on a free key it answers 429, which the router treats as
 * retryable and so retries and falls back — turning a configuration problem
 * into a slow one. A deployment with billing can add it here with a
 * `reasoningTier` above the flash models, and judgment and synthesis will route
 * to it.
 *
 * `gemini-embedding-001` is the reason a Gemini deployment has non-lexical
 * retrieval where an Anthropic-only one does not: it is the only embedding
 * model in either catalog.
 */
export const GEMINI_MODEL_SPECS: readonly ModelSpec[] = [
  {
    id: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    capabilities: [...TEXT_AGENT_CAPABILITIES, "reasoning"],
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningTier: 0.85,
    speedTier: 0.8,
  },
  {
    id: "gemini-flash-latest",
    displayName: "Gemini Flash (latest)",
    capabilities: [...TEXT_AGENT_CAPABILITIES, "reasoning"],
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningTier: 0.8,
    speedTier: 0.85,
  },
  {
    id: "gemini-flash-lite-latest",
    displayName: "Gemini Flash-Lite (latest)",
    capabilities: TEXT_AGENT_CAPABILITIES,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningTier: 0.5,
    speedTier: 1,
  },
  {
    id: "gemini-embedding-001",
    displayName: "Gemini Embedding 001",
    capabilities: ["embedding"],
    maxInputTokens: 2_048,
    maxOutputTokens: 1,
    reasoningTier: 0,
    speedTier: 1,
  },
];

export function findSpec(specs: readonly ModelSpec[], id: string): ModelSpec | undefined {
  return specs.find((spec) => spec.id === id);
}

/**
 * Joins specs with configured pricing into the descriptors the router uses.
 * Throws — loudly, naming the model — rather than defaulting a missing price.
 */
export function describeModels(
  provider: string,
  specs: readonly ModelSpec[],
  pricing: PricingTable,
): ModelDescriptor[] {
  return specs.map((spec) => {
    const rates = pricing[spec.id];
    if (!rates) {
      throw err.validation(
        `No pricing configured for model "${spec.id}". Cost accounting drives budget enforcement, so ResearchOS will not run a model it cannot price. Set RESEARCH_OS_MODEL_PRICING, or pass pricing when constructing the ${provider} provider.`,
        { model: spec.id, provider },
      );
    }
    return {
      id: spec.id,
      provider,
      displayName: spec.displayName,
      capabilities: [...spec.capabilities],
      maxInputTokens: spec.maxInputTokens,
      maxOutputTokens: spec.maxOutputTokens,
      inputCostPerMTokUsd: rates.inputCostPerMTokUsd,
      outputCostPerMTokUsd: rates.outputCostPerMTokUsd,
      ...(rates.cachedInputCostPerMTokUsd === undefined
        ? {}
        : { cachedInputCostPerMTokUsd: rates.cachedInputCostPerMTokUsd }),
      reasoningTier: spec.reasoningTier,
      speedTier: spec.speedTier,
    };
  });
}

/**
 * Reads `RESEARCH_OS_MODEL_PRICING`, a JSON object keyed by model id:
 *
 *   {"claude-sonnet-5":{"inputCostPerMTokUsd":3,"outputCostPerMTokUsd":15}}
 *
 * Returns an empty table when unset, so the error surfaces at provider
 * construction with the model's name rather than here without it.
 */
export function pricingFromEnv(env: EnvSource = process.env): PricingTable {
  const raw = readOptionalString(env, "RESEARCH_OS_MODEL_PRICING");
  if (!raw) return {};

  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw err.validation("RESEARCH_OS_MODEL_PRICING must be a JSON object keyed by model id.");
  }

  const table: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw err.validation(`RESEARCH_OS_MODEL_PRICING["${model}"] must be an object.`, { model });
    }
    const entry = value as Record<string, unknown>;
    const input = entry["inputCostPerMTokUsd"];
    const output = entry["outputCostPerMTokUsd"];
    const cached = entry["cachedInputCostPerMTokUsd"];
    if (typeof input !== "number" || typeof output !== "number") {
      throw err.validation(
        `RESEARCH_OS_MODEL_PRICING["${model}"] needs numeric inputCostPerMTokUsd and outputCostPerMTokUsd.`,
        { model },
      );
    }
    table[model] = {
      inputCostPerMTokUsd: input,
      outputCostPerMTokUsd: output,
      ...(typeof cached === "number" ? { cachedInputCostPerMTokUsd: cached } : {}),
    };
  }
  return table;
}
