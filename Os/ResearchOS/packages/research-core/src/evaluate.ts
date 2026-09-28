/**
 * Gathering a project's artifacts and scoring how it was conducted.
 *
 * The rubric itself is pure and lives in `@research-os/evaluation`. This is the
 * part that reads the database, kept separate so the scoring rules stay
 * exhaustively testable without one.
 */
import { evaluateProject, EVALUATION_CAVEATS, type EvaluationResult } from "@research-os/evaluation";
import type { ResearchStore } from "@research-os/persistence";

export interface ProjectEvaluation extends EvaluationResult {
  readonly projectId: string;
  readonly evaluatedAt: string;
  /** What the rubric cannot see. Returned every time, so it cannot be inferred away. */
  readonly caveats: readonly string[];
}

export async function evaluateResearchProject(
  store: ResearchStore,
  projectId: string,
  now: string = new Date().toISOString(),
): Promise<ProjectEvaluation> {
  const [claims, evidence, evidenceLinks, sources, contradictions, findings, checks, report, tasks, experiments] =
    await Promise.all([
      store.research.listClaims(projectId, { limit: 500 }),
      store.research.listEvidence(projectId, { limit: 1000 }),
      store.research.listEvidenceLinks(projectId),
      store.research.listSources(projectId, { limit: 500 }),
      store.research.listContradictions(projectId),
      store.runs.listFindings(projectId, { limit: 500 }),
      store.runs.listVerificationChecks(projectId, 1000),
      store.reports.latest(projectId),
      store.tasks.list(projectId, { limit: 300 }),
      store.experiments.listExperiments(projectId),
    ]);

  const reproducibility: number[] = [];
  for (const experiment of experiments) {
    const summary = await store.experiments.replicationSummary(experiment.id);
    if (summary.totalRuns > 0) reproducibility.push(summary.reproducibilityScore);
  }

  const result = evaluateProject({
    claims,
    evidence,
    evidenceLinks,
    sources,
    contradictions,
    findings,
    verificationChecks: checks,
    report: report ?? null,
    completedTaskTypes: tasks.filter((task) => task.status === "completed").map((task) => task.type),
    blockedWork: tasks
      .filter((task) => (task.errorMessage ?? "").startsWith("BLOCKED:"))
      .map((task) => `${task.type}: ${(task.errorMessage ?? "").replace(/^BLOCKED:\s*/, "")}`),
    experimentReproducibility: reproducibility,
  });

  return { ...result, projectId, evaluatedAt: now, caveats: EVALUATION_CAVEATS };
}
