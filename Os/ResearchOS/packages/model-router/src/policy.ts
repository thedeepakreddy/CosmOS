/**
 * Default routing policy.
 *
 * Rules are expressed in terms of the *kind of work*, never a model tier, which
 * is what lets the policy change without touching a single agent. An agent asks
 * for `critique`; whether that is served by the strongest available model or a
 * cheap one is an operational decision made here.
 *
 * Ordering within `candidates` is preference, not fallback-only: the first
 * healthy candidate that satisfies the required capabilities wins, and the rest
 * are tried in order if it fails.
 */
import type { ModelRoutingRule, ModelTaskKind } from "@research-os/contracts";

const OPUS = { provider: "anthropic", model: "claude-opus-5" } as const;
const SONNET = { provider: "anthropic", model: "claude-sonnet-5" } as const;
const HAIKU = { provider: "anthropic", model: "claude-haiku-4-5-20251001" } as const;

/**
 * Work that decides what the research *concludes* routes to the strongest
 * model; work that transforms text someone else will check can go cheaper.
 * Getting extraction slightly wrong is recoverable — a later verification pass
 * catches it. Getting judgment wrong is what the whole system exists to avoid.
 */
export const DEFAULT_ROUTING_RULES: readonly ModelRoutingRule[] = [
  { taskKind: "planning", candidates: [OPUS, SONNET], requiredCapabilities: ["text"], requireDistinctProvider: false },
  { taskKind: "extraction", candidates: [HAIKU, SONNET], requiredCapabilities: ["structured_output"], requireDistinctProvider: false },
  { taskKind: "analysis", candidates: [SONNET, OPUS], requiredCapabilities: ["text"], requireDistinctProvider: false },
  { taskKind: "critique", candidates: [OPUS, SONNET], requiredCapabilities: ["text"], requireDistinctProvider: false },
  { taskKind: "judgment", candidates: [OPUS, SONNET], requiredCapabilities: ["text"], requireDistinctProvider: false },
  { taskKind: "coding", candidates: [SONNET, OPUS], requiredCapabilities: ["text"], requireDistinctProvider: false },
  { taskKind: "long_document", candidates: [SONNET, HAIKU], requiredCapabilities: ["long_context"], requireDistinctProvider: false },
  { taskKind: "vision", candidates: [SONNET, OPUS], requiredCapabilities: ["vision"], requireDistinctProvider: false },
  { taskKind: "synthesis", candidates: [OPUS, SONNET], requiredCapabilities: ["text"], requireDistinctProvider: false },

  /*
   * Verification asks for a provider other than the one that produced the
   * artifact. A model is a poor judge of its own output — it repeats the
   * reasoning that produced the error rather than catching it.
   *
   * With only one provider configured this cannot be satisfied. The router does
   * not pretend otherwise: it routes anyway and reports `independent: false`, so
   * the verification record says the check was self-reviewed. Silently
   * presenting a self-check as independent verification would be worse than not
   * verifying at all, because it would carry unearned confidence.
   */
  { taskKind: "verification", candidates: [OPUS, SONNET, HAIKU], requiredCapabilities: ["text"], requireDistinctProvider: true },
];

export function ruleFor(rules: readonly ModelRoutingRule[], taskKind: ModelTaskKind): ModelRoutingRule | undefined {
  return rules.find((rule) => rule.taskKind === taskKind);
}
