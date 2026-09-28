import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, Metadata, TenantId, UnitInterval, ClientIdentity, CitationStyle } from "./primitives.ts";

export const PROJECT_STATUSES = [
  "draft",
  "planning",
  "running",
  "awaiting_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export const ProjectStatus = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const RESEARCH_DEPTHS = ["shallow", "standard", "deep", "exhaustive"] as const;
export const ResearchDepth = z.enum(RESEARCH_DEPTHS);
export type ResearchDepth = z.infer<typeof ResearchDepth>;

/**
 * Hard ceilings on a research run. Checked before every model call, tool call
 * and task dispatch. A run that hits a ceiling stops and says so — it never
 * silently degrades into a shallower answer.
 */
export const ResearchBudget = z.object({
  maxTokens: z.number().int().positive().default(2_000_000),
  maxCostUsd: z.number().nonnegative().default(10),
  maxWallClockMs: z.number().int().positive().default(30 * 60_000),
  maxModelCalls: z.number().int().positive().default(400),
  maxToolCalls: z.number().int().positive().default(400),
  maxSources: z.number().int().positive().default(60),
  maxTasks: z.number().int().positive().default(500),
});
export type ResearchBudget = z.infer<typeof ResearchBudget>;

/**
 * Caller-supplied preferences. Deliberately separate from research knowledge:
 * these describe how a client wants research conducted and presented, and must
 * never influence what the evidence says.
 */
export const ResearchPreferences = z.object({
  citationStyle: CitationStyle.default("apa"),
  depth: ResearchDepth.default("standard"),
  /** Minimum source-quality score for evidence to count toward a conclusion. */
  minSourceQuality: UnitInterval.default(0.3),
  /** Tool ids the run is allowed to use. Empty means "registry defaults". */
  allowedTools: z.array(z.string()).default([]),
  /** Model routing overrides, keyed by task kind. */
  modelOverrides: z.record(z.string(), z.string()).default({}),
  /** Domains the run must not fetch from. */
  blockedDomains: z.array(z.string()).default([]),
  preferredDomains: z.array(z.string()).default([]),
  language: z.string().min(2).max(16).default("en"),
  /** When true, evidence text is never sent to providers outside the allowlist. */
  restrictDataEgress: z.boolean().default(false),
  requireIndependentVerification: z.boolean().default(true),
});
export type ResearchPreferences = z.infer<typeof ResearchPreferences>;

export const Objective = z.object({
  id: idSchema("objective"),
  projectId: idSchema("project"),
  statement: z.string().min(1).max(2000),
  rationale: z.string().max(4000).optional(),
  position: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
});
export type Objective = z.infer<typeof Objective>;

export const QUESTION_KINDS = ["primary", "sub", "emergent"] as const;
export const QuestionKind = z.enum(QUESTION_KINDS);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QUESTION_STATUSES = ["open", "investigating", "answered", "unanswerable", "deferred"] as const;
export const QuestionStatus = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const ResearchQuestion = z.object({
  id: idSchema("question"),
  projectId: idSchema("project"),
  parentQuestionId: idSchema("question").nullable(),
  text: z.string().min(1).max(2000),
  kind: QuestionKind,
  status: QuestionStatus,
  /** Why this question matters to the parent objective. */
  rationale: z.string().max(4000).optional(),
  priority: z.number().int().min(0).max(100),
  /** Populated when status becomes `answered`; always traceable to claims. */
  answerSummary: z.string().max(8000).optional(),
  answerClaimIds: z.array(idRefSchema("claim")).default([]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ResearchQuestion = z.infer<typeof ResearchQuestion>;

export const HYPOTHESIS_STATUSES = ["proposed", "testing", "supported", "refuted", "inconclusive", "abandoned"] as const;
export const HypothesisStatus = z.enum(HYPOTHESIS_STATUSES);
export type HypothesisStatus = z.infer<typeof HypothesisStatus>;

export const Hypothesis = z.object({
  id: idSchema("hypothesis"),
  projectId: idSchema("project"),
  questionId: idSchema("question").nullable(),
  statement: z.string().min(1).max(2000),
  rationale: z.string().max(4000).optional(),
  status: HypothesisStatus,
  /** What observation would refute this. A hypothesis without one is not testable. */
  falsificationCriteria: z.string().max(2000).optional(),
  /** Belief before evidence, and after. Both derived, never model-asserted. */
  priorConfidence: UnitInterval.nullable(),
  posteriorConfidence: UnitInterval.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const ResearchProject = z.object({
  id: idSchema("project"),
  tenantId: TenantId.nullable(),
  createdBy: ClientIdentity.nullable(),
  title: z.string().min(1).max(500),
  description: z.string().max(8000).nullable(),
  originalQuestion: z.string().min(1).max(8000),
  status: ProjectStatus,
  preferences: ResearchPreferences,
  budget: ResearchBudget,
  /** Set when status is `failed`. */
  failureReason: z.string().max(4000).nullable(),
  metadata: Metadata.default({}),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type ResearchProject = z.infer<typeof ResearchProject>;

/** Aggregate counts exposed on the status endpoint so clients need no extra round trips. */
export const ProjectProgress = z.object({
  tasksTotal: z.number().int().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
  tasksRunning: z.number().int().nonnegative(),
  sourcesDiscovered: z.number().int().nonnegative(),
  sourcesProcessed: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  claimsCount: z.number().int().nonnegative(),
  contradictionsOpen: z.number().int().nonnegative(),
  experimentsCompleted: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
});
export type ProjectProgress = z.infer<typeof ProjectProgress>;
