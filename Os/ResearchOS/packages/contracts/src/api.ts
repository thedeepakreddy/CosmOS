import { z } from "zod";
import { idRefSchema, Pagination, pageSchema, ClientIdentity, Metadata } from "./primitives.ts";
import { ResearchProject, ProjectProgress, ResearchPreferences, ResearchBudget, ResearchQuestion, Hypothesis, Objective } from "./project.ts";
import { Source } from "./source.ts";
import { Evidence } from "./evidence.ts";
import { Claim, Contradiction, ClaimRelation } from "./claim.ts";
import { Task, ResearchPlan } from "./task.ts";
import { AgentRun, CritiqueFinding } from "./agent.ts";
import { Experiment, ExperimentRun } from "./experiment.ts";
import { ResearchGraph, ResearchTree } from "./graph.ts";
import { ResearchReport } from "./report.ts";
import { Debate } from "./debate.ts";
import { ExecutorRegistration, Executor, ExecutorRequest, ExecutorResult } from "./executor.ts";
import { SourceType } from "./source.ts";

/**
 * API contracts.
 *
 * Request and response shapes for `/api/v1`. These are what the TypeScript SDK
 * is built from and what the OpenAPI document is generated from, so a change
 * here is visible to every client at compile time.
 */

export const API_VERSION = "v1" as const;

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: Metadata.optional(),
    /** Correlates a client-side failure with server logs. */
    traceId: z.string().nullable(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/* ---------- Projects ---------- */

export const CreateProjectRequest = z.object({
  question: z.string().min(3).max(8000),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(8000).optional(),
  preferences: ResearchPreferences.partial().optional(),
  budget: ResearchBudget.partial().optional(),
  client: ClientIdentity.optional(),
  metadata: Metadata.optional(),
  /** Start the run immediately instead of leaving the project in `draft`. */
  autoStart: z.boolean().default(false),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const ProjectResponse = z.object({ project: ResearchProject });
export type ProjectResponse = z.infer<typeof ProjectResponse>;

export const ProjectDetailResponse = z.object({
  project: ResearchProject,
  progress: ProjectProgress,
  objectives: z.array(Objective),
  questions: z.array(ResearchQuestion),
  hypotheses: z.array(Hypothesis),
  plan: ResearchPlan.nullable(),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponse>;

export const ProjectStatusResponse = z.object({
  projectId: idRefSchema("project"),
  status: ResearchProject.shape.status,
  progress: ProjectProgress,
  /** Tasks currently running, so a client can show live activity. */
  activeTasks: z.array(z.object({ taskId: idRefSchema("task"), type: Task.shape.type, startedAt: z.string().nullable() })),
  activeAgents: z.array(z.object({ runId: idRefSchema("agentRun"), role: AgentRun.shape.role, startedAt: z.string() })),
  lastEventSequence: z.number().int().nonnegative(),
});
export type ProjectStatusResponse = z.infer<typeof ProjectStatusResponse>;

export const RunProjectRequest = z.object({
  /** Overrides applied to this run only; the project's stored values are unchanged. */
  budget: ResearchBudget.partial().optional(),
  preferences: ResearchPreferences.partial().optional(),
  /** Re-plan from scratch rather than resuming an interrupted run. */
  restart: z.boolean().default(false),
});
export type RunProjectRequest = z.infer<typeof RunProjectRequest>;

export const RunProjectResponse = z.object({
  projectId: idRefSchema("project"),
  status: ResearchProject.shape.status,
  planVersion: z.number().int().positive(),
  tasksQueued: z.number().int().nonnegative(),
});
export type RunProjectResponse = z.infer<typeof RunProjectResponse>;

export const PostMessageRequest = z.object({
  /** Guidance, a constraint, or an answer to a `waiting_for_user` task. */
  message: z.string().min(1).max(8000),
  /** Task this message answers, when responding to a request for input. */
  respondingToTaskId: idRefSchema("task").optional(),
  client: ClientIdentity.optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const PostMessageResponse = z.object({
  accepted: z.boolean(),
  /** Tasks created or unblocked as a result. */
  affectedTaskIds: z.array(idRefSchema("task")),
  note: z.string().optional(),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;

export const CancelProjectRequest = z.object({ reason: z.string().max(1000).optional() });
export type CancelProjectRequest = z.infer<typeof CancelProjectRequest>;

/* ---------- Research artifacts ---------- */

export const ListProjectsQuery = Pagination.extend({
  status: ResearchProject.shape.status.optional(),
  application: z.string().max(64).optional(),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuery>;

export const ProjectsPage = pageSchema(ResearchProject);
export type ProjectsPage = z.infer<typeof ProjectsPage>;

export const ListClaimsQuery = Pagination.extend({
  status: Claim.shape.status.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  questionId: idRefSchema("question").optional(),
});
export type ListClaimsQuery = z.infer<typeof ListClaimsQuery>;

export const ClaimsPage = pageSchema(Claim);
export const EvidencePage = pageSchema(Evidence);
export const SourcesPage = pageSchema(Source);
export const TasksPage = pageSchema(Task);
export const AgentRunsPage = pageSchema(AgentRun);
export const ExperimentsPage = pageSchema(Experiment);
export const FindingsPage = pageSchema(CritiqueFinding);

/** A claim with everything needed to display and audit it. */
export const ClaimDetailResponse = z.object({
  claim: Claim,
  evidence: z.array(z.object({ evidence: Evidence, source: Source, stance: Evidence.shape.stance, rationale: z.string().nullable() })),
  relations: z.array(ClaimRelation),
  contradictions: z.array(Contradiction),
  findings: z.array(CritiqueFinding),
  debates: z.array(Debate),
});
export type ClaimDetailResponse = z.infer<typeof ClaimDetailResponse>;

export const AddEvidenceRequest = z.object({
  /** Supply either a URL to ingest, or the content directly. */
  url: z.string().url().optional(),
  title: z.string().min(1).max(1000).optional(),
  content: z.string().max(2_000_000).optional(),
  sourceType: SourceType.default("user_supplied"),
  authors: z.array(z.string().max(300)).default([]),
  publishedAt: z.string().optional(),
  /** Question this material is meant to inform. */
  questionId: idRefSchema("question").optional(),
  metadata: Metadata.optional(),
}).refine((value) => Boolean(value.url ?? value.content), {
  message: "Either `url` or `content` must be provided",
});
export type AddEvidenceRequest = z.infer<typeof AddEvidenceRequest>;

export const AddEvidenceResponse = z.object({
  sourceId: idRefSchema("source"),
  taskId: idRefSchema("task").nullable(),
  status: Source.shape.status,
});
export type AddEvidenceResponse = z.infer<typeof AddEvidenceResponse>;

export const GraphResponse = z.object({ graph: ResearchGraph });
export const TreeResponse = z.object({ tree: ResearchTree });
export const ReportResponse = z.object({ report: ResearchReport });
export const ExperimentDetailResponse = z.object({ experiment: Experiment, runs: z.array(ExperimentRun) });

/* ---------- Executors ---------- */

export const RegisterExecutorRequest = ExecutorRegistration;
export const RegisterExecutorResponse = z.object({
  executor: Executor,
  /** Bearer token the executor presents on subsequent calls. Returned once. */
  token: z.string(),
});
export type RegisterExecutorResponse = z.infer<typeof RegisterExecutorResponse>;

export const ClaimWorkQuery = z.object({
  /** Subset of the executor's capabilities to receive work for. */
  capabilities: z.array(z.string()).default([]),
  max: z.number().int().min(1).max(10).default(1),
  /** Long-poll duration for pull-mode executors. */
  waitMs: z.number().int().min(0).max(60_000).default(0),
});
export type ClaimWorkQuery = z.infer<typeof ClaimWorkQuery>;

export const ClaimWorkResponse = z.object({ requests: z.array(ExecutorRequest) });
export const SubmitExecutorResultRequest = ExecutorResult;
export const SubmitExecutorResultResponse = z.object({ accepted: z.boolean(), taskResumed: z.boolean() });

/* ---------- Events ---------- */

export const EventsQuery = z.object({
  /** Resume from this sequence number, exclusive. Mirrors SSE `Last-Event-ID`. */
  since: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(200),
  types: z.array(z.string()).default([]),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  checks: z.record(z.string(), z.object({ status: z.enum(["ok", "error"]), detail: z.string().optional() })),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
