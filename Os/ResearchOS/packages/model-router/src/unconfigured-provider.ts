/**
 * The provider a deployment gets when it has none.
 *
 * ResearchOS starts without a model key on purpose — refusing to boot would
 * leave an operator with no API to ask why — but every research task then fails,
 * and the message it fails with is the only thing standing between the operator
 * and a confusing afternoon.
 *
 * So this exists rather than reusing a test double. A failure reading
 * "ScriptedModelProvider ran out of script" describes an internal detail of the
 * test harness; one reading "no model provider is configured, set
 * ANTHROPIC_API_KEY" describes the actual problem and its fix.
 *
 * Mirrors `UnavailableExperimentRunner`: the honest implementation of an absent
 * capability is one that refuses clearly, not one that returns something.
 */
import type { ModelDescriptor, ModelResponse } from "@research-os/contracts";
import { err } from "@research-os/shared";
import type { EmbedRequest, GenerateRequest, ModelProvider } from "./provider.ts";

export const UNCONFIGURED_PROVIDER_NAME = "unconfigured";

export const UNCONFIGURED_REASON =
  "No model provider is configured. Set ANTHROPIC_API_KEY and RESEARCH_OS_MODEL_PRICING, " +
  "or register a provider when building the runtime. Research tasks cannot run without one.";

/**
 * A single descriptor with every capability declared.
 *
 * Declaring capabilities it cannot deliver is deliberate: routing should reach
 * this provider and fail with the real reason, rather than failing earlier with
 * "no candidate satisfies the required capabilities", which would send the
 * operator looking for a capability problem they do not have.
 */
const PLACEHOLDER: ModelDescriptor = {
  id: "unconfigured",
  provider: UNCONFIGURED_PROVIDER_NAME,
  displayName: "No model provider configured",
  capabilities: ["text", "tool_use", "structured_output", "streaming", "long_context", "vision", "reasoning"],
  maxInputTokens: 200_000,
  maxOutputTokens: 8_192,
  inputCostPerMTokUsd: 0,
  outputCostPerMTokUsd: 0,
  reasoningTier: 0,
  speedTier: 0,
};

export class UnconfiguredModelProvider implements ModelProvider {
  readonly name = UNCONFIGURED_PROVIDER_NAME;
  readonly models: readonly ModelDescriptor[] = [PLACEHOLDER];
  readonly #reason: string;

  constructor(reason: string = UNCONFIGURED_REASON) {
    this.#reason = reason;
  }

  async generate(_request: GenerateRequest): Promise<ModelResponse> {
    // Not retryable: waiting does not configure a provider, and retrying would
    // spend the task's whole attempt budget reaching the same answer.
    throw err.provider(this.#reason, { retryable: false });
  }

  async embed(_request: EmbedRequest): Promise<never> {
    throw err.provider(this.#reason, { retryable: false });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: this.#reason };
  }
}
