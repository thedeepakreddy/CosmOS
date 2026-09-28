/**
 * The agent base.
 *
 * An agent is a *role* — a declared responsibility with a typed input and a
 * schema-validated output — not a prompt. That distinction is what lets a role
 * be re-implemented with a different model or a different technique without any
 * caller changing, and it is why every agent here declares an output schema
 * rather than returning prose.
 *
 * Four things happen around every agent call, and none of them is optional:
 *
 *   - **The run is recorded before the model is called**, so a crash mid-call
 *     leaves a `running` row rather than no trace at all.
 *   - **Output is validated against the schema.** An agent that cannot produce
 *     its contract has failed; it has not "returned something".
 *   - **Cost is attributed to the run**, which is what makes budget enforcement
 *     and per-agent cost reporting possible.
 *   - **The provider is recorded**, because independence of a later verification
 *     can only be proven if we know who produced the thing being verified.
 */
import type {
  AgentRole, AgentRun, ModelMessage, ModelTaskKind, ResearchPreferences,
} from "@research-os/contracts";
import type { ModelRouter, RouteDecision } from "@research-os/model-router";
import { toLogError, type Logger, type Tracer } from "@research-os/observability";
import type { ResearchStore } from "@research-os/persistence";
import type { ToolRegistry } from "@research-os/tools";
import type { ResearchMemory } from "@research-os/memory";
import { newId, systemClock, toResearchError, type Clock } from "@research-os/shared";
import type { z } from "zod";

export interface AgentContext {
  readonly projectId: string;
  readonly taskId?: string | null;
  readonly store: ResearchStore;
  readonly router: ModelRouter;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly preferences: ResearchPreferences;
  readonly tools?: ToolRegistry;
  readonly memory?: ResearchMemory;
  readonly tracer?: Tracer;
  readonly signal?: AbortSignal;
  /**
   * How much of the run's budget is spent, in [0,1].
   *
   * Passed through to the router, which uses it to trade model strength for
   * reach near a ceiling. Absent means no pressure, so an agent run outside a
   * worker behaves exactly as the policy says.
   */
  readonly budgetPressure?: number;
}

export interface AgentResult<Output> {
  readonly output: Output;
  readonly runId: string;
  /** Provider that produced this, so a later verifier can route away from it. */
  readonly provider: string;
  readonly model: string;
  readonly decision: RouteDecision;
}

export interface AgentDefinition<Input, Output> {
  readonly role: AgentRole;
  readonly taskKind: ModelTaskKind;
  readonly outputSchema: z.ZodType<Output>;
  /** The agent's standing instructions. Stable across calls. */
  systemPrompt(context: AgentContext): string;
  /** The per-call request, built from structured input rather than free text. */
  userPrompt(input: Input, context: AgentContext): string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

/**
 * Instructions every agent inherits.
 *
 * These are the house rules of the system, stated once. They exist because each
 * describes a specific way a research system silently goes wrong: inventing a
 * source, asserting a confidence number, hiding a disagreement, or answering
 * from training data instead of from the evidence in front of it.
 */
export const SHARED_AGENT_RULES = `You are part of ResearchOS, a research system whose output must be traceable.

Rules that apply to every response:
1. Never invent a source, citation, URL, DOI, author or publication. If you need
   evidence you do not have, say so; a gap that is stated is useful, a gap that
   is filled in is corruption.
2. Quote verbatim when you quote. Every quotation is mechanically checked against
   the source text, and a paraphrase inside quotation marks is recorded as a
   verification failure.
3. Distinguish what a source says from what you infer from it. These are
   different kinds of statement and are stored in different fields.
4. Do not assert numeric confidence. Confidence is computed from evidence weight
   and independence by the system, not asserted by a model.
5. Report disagreement rather than resolving it silently. A contradiction is a
   finding, not an error to be averaged away.
6. Answer from the material provided, not from memory. If the material does not
   settle the question, that is the answer.
7. Respond with JSON matching the requested schema. No prose outside it.`;

/**
 * Runs an agent: record, call, validate, attribute.
 *
 * Failures are recorded and rethrown rather than swallowed. The orchestrator
 * decides whether to retry, and it can only do that if the failure reaches it.
 */
export async function runAgent<Input, Output>(
  definition: AgentDefinition<Input, Output>,
  input: Input,
  context: AgentContext,
  options: { excludeProvider?: string; overrideModel?: string } = {},
): Promise<AgentResult<Output>> {
  const clock = context.clock ?? systemClock;
  const startedAt = clock.now();
  const runId = newId("agentRun");
  const logger = context.logger.child({ agentRole: definition.role, runId });

  const run: AgentRun = {
    id: runId,
    projectId: context.projectId,
    taskId: context.taskId ?? null,
    role: definition.role,
    status: "running",
    model: null,
    provider: null,
    input,
    output: null,
    usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
    traceId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: clock.isoNow(),
    finishedAt: null,
    durationMs: null,
  } as AgentRun;

  await context.store.runs.startRun(run);

  try {
    const messages: ModelMessage[] = [{ role: "user", content: definition.userPrompt(input, context) }];
    const overrideModel = options.overrideModel ?? context.preferences.modelOverrides[definition.taskKind];

    const result = await context.router.structured({
      taskKind: definition.taskKind,
      schema: definition.outputSchema,
      system: `${SHARED_AGENT_RULES}\n\n${definition.systemPrompt(context)}`,
      messages,
      ...(definition.maxOutputTokens === undefined ? {} : { maxOutputTokens: definition.maxOutputTokens }),
      ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
      ...(options.excludeProvider ? { excludeProvider: options.excludeProvider } : {}),
      ...(context.budgetPressure === undefined ? {} : { budget: { pressure: context.budgetPressure } }),
      ...(overrideModel ? { overrideModel } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    const durationMs = clock.now() - startedAt;
    await context.store.runs.finishRun(
      runId,
      {
        status: "completed",
        output: result.value,
        usage: {
          modelCalls: result.attempts,
          toolCalls: 0,
          inputTokens: result.response.usage.inputTokens,
          outputTokens: result.response.usage.outputTokens,
          cachedInputTokens: result.response.usage.cachedInputTokens,
          costUsd: result.response.usage.costUsd,
        },
        model: result.response.model,
        provider: result.response.provider,
      },
      clock.isoNow(),
      durationMs,
    );

    if (result.repairs > 0) {
      logger.warn("Agent output needed repair before it validated", { repairs: result.repairs });
    }
    if (result.decision.adaptive.tier !== "none") {
      // Recorded rather than silent: a report should be able to say which parts
      // of a run were produced under budget pressure.
      logger.info("Agent ran on a downgraded model", {
        tier: result.decision.adaptive.tier,
        model: result.response.model,
        reason: result.decision.adaptive.reason,
      });
    }

    return {
      output: result.value,
      runId,
      provider: result.response.provider,
      model: result.response.model,
      decision: result.decision,
    };
  } catch (thrown) {
    const error = toResearchError(thrown);
    await context.store.runs.finishRun(
      runId,
      { status: error.code === "budget_exhausted" ? "budget_exhausted" : "failed", errorCode: error.code, errorMessage: error.message },
      clock.isoNow(),
      clock.now() - startedAt,
    );
    logger.error("Agent failed", { error: toLogError(error) });
    throw error;
  }
}

/** Renders numbered material for a prompt, so a model can cite by index. */
export function numbered(items: readonly string[], label = "Item"): string {
  return items.map((item, index) => `[${label} ${index + 1}]\n${item}`).join("\n\n");
}
