import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, Metadata, UnitInterval } from "./primitives.ts";

/**
 * Agent roles.
 *
 * A role is a contract — a declared responsibility with typed input and output —
 * not a prompt. Prompts are an implementation detail of the agent that fills
 * the role, which is what allows a role to be re-implemented (different model,
 * different provider, different technique) without changing any caller.
 */
export const AGENT_ROLES = [
  "research_director",
  "evidence_agent",
  "claim_extractor",
  "skeptic",
  "verifier",
  "data_analyst",
  "experimenter",
  "judge",
  "synthesizer",
] as const;
export const AgentRole = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRole>;

export const AGENT_RUN_STATUSES = ["running", "completed", "failed", "cancelled", "budget_exhausted"] as const;
export const AgentRunStatus = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

/** Per-run resource accounting. Rolls up into project budget enforcement. */
export const AgentRunUsage = z.object({
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type AgentRunUsage = z.infer<typeof AgentRunUsage>;

export const AgentRun = z.object({
  id: idSchema("agentRun"),
  projectId: idSchema("project"),
  taskId: idSchema("task").nullable(),
  role: AgentRole,
  status: AgentRunStatus,
  /** Model actually used, as reported by the provider. */
  model: z.string().max(200).nullable(),
  provider: z.string().max(100).nullable(),
  /** Structured input the agent was given. Stored for replay and debugging. */
  input: z.unknown(),
  /** Structured, schema-validated output. Never raw prose. */
  output: z.unknown().nullable(),
  usage: AgentRunUsage,
  traceId: idRefSchema("trace").nullable(),
  errorCode: z.string().max(100).nullable(),
  errorMessage: z.string().max(4000).nullable(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

/**
 * A finding raised by the skeptic or verifier against existing research state.
 * Findings are persisted rather than folded into prose so that "what did the
 * critic object to, and was it addressed?" is answerable after the fact.
 */
export const FINDING_KINDS = [
  "unsupported_claim",
  "flawed_assumption",
  "alternative_explanation",
  "contradictory_evidence",
  "weak_methodology",
  "possible_hallucination",
  "logical_gap",
  "overgeneralization",
  "citation_mismatch",
  "arithmetic_error",
  "selection_bias",
  "stale_evidence",
] as const;
export const FindingKind = z.enum(FINDING_KINDS);
export type FindingKind = z.infer<typeof FindingKind>;

export const FINDING_STATUSES = ["open", "accepted", "rejected", "addressed"] as const;
export const FindingStatus = z.enum(FINDING_STATUSES);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const CritiqueFinding = z.object({
  id: idSchema("finding"),
  projectId: idSchema("project"),
  kind: FindingKind,
  status: FindingStatus,
  /** What the finding is about: a claim, evidence item, experiment or report section. */
  targetType: z.enum(["claim", "evidence", "hypothesis", "experiment", "report_section", "source"]),
  targetId: z.string().max(64),
  description: z.string().min(1).max(4000),
  /** What would have to be true for this objection to be resolved. */
  resolutionCriteria: z.string().max(2000).nullable(),
  severity: UnitInterval,
  raisedByRunId: idRefSchema("agentRun").nullable(),
  resolvedByRunId: idRefSchema("agentRun").nullable(),
  resolution: z.string().max(4000).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CritiqueFinding = z.infer<typeof CritiqueFinding>;

/**
 * Failure memory.
 *
 * The record that lets a later run know "we already tried this and it failed
 * because X". Persisted at project scope and retrievable across projects for
 * the same tenant.
 */
export const FAILURE_KINDS = [
  "failed_experiment",
  "rejected_hypothesis",
  "dead_end_approach",
  "broken_pipeline",
  "unreliable_source",
  "tool_limitation",
  "known_limitation",
] as const;
export const FailureKind = z.enum(FAILURE_KINDS);
export type FailureKind = z.infer<typeof FailureKind>;

export const FailureRecord = z.object({
  id: idSchema("failure"),
  projectId: idSchema("project"),
  kind: FailureKind,
  /** What was attempted, stated so a future run can recognise the same approach. */
  approach: z.string().min(1).max(2000),
  /** Why it failed. The actionable half. */
  reason: z.string().min(1).max(4000),
  /** Generalised lesson, if one can be drawn. */
  lesson: z.string().max(2000).nullable(),
  context: Metadata.default({}),
  /** Whether this is likely to generalise beyond this project. */
  transferable: z.boolean().default(false),
  recordedByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
});
export type FailureRecord = z.infer<typeof FailureRecord>;
