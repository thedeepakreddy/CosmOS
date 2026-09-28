/**
 * The report handler.
 *
 * Assembles the structured report from stored research state, asks the
 * synthesiser for prose, joins them, and stores the result as a new version.
 *
 * The order is deliberate. Findings, citations and statistics are computed
 * before the model is called, and the model is given them rather than asked to
 * produce them. A synthesiser that could introduce a finding would be a way for
 * an unevidenced assertion to enter a document whose entire value is that every
 * sentence traces to a claim.
 */
import type { TaskOutcome } from "@research-os/contracts";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { runAgent } from "../agent.ts";
import { synthesizer } from "../agents/synthesizer.ts";
import type { ResearchDeps } from "../deps.ts";
import { assembleReport, buildReportStructure, reportableClaims } from "../report.ts";
import { agentContextFor, completed, emit } from "./support.ts";

export function reportGenerateHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "report.generate",
    leaseMs: 300_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const project = await deps.store.projects.findById(task.projectId);
      /* c8 ignore next */
      if (!project) return { kind: "failed", errorCode: "not_found", errorMessage: "Project vanished.", retryable: false };

      const [claims, evidence, evidenceLinks, sources, contradictions, questions, findings, usage] = await Promise.all([
        deps.store.research.listClaims(task.projectId, { limit: 500 }),
        deps.store.research.listEvidence(task.projectId, { limit: 1000 }),
        deps.store.research.listEvidenceLinks(task.projectId),
        deps.store.research.listSources(task.projectId, { limit: 500 }),
        deps.store.research.listContradictions(task.projectId),
        deps.store.projects.listQuestions(task.projectId),
        deps.store.runs.listFindings(task.projectId, { status: "open" }),
        deps.store.runs.usageTotals(task.projectId),
      ]);

      // Tasks that were blocked become limitations. A report that omits what it
      // could not do overstates what it did.
      const blockedWork = (await deps.store.tasks.list(task.projectId, { status: "failed", limit: 100 }))
        .filter((failed) => (failed.errorMessage ?? "").startsWith("BLOCKED:"))
        .map((failed) => `${failed.type}: ${(failed.errorMessage ?? "").replace(/^BLOCKED:\s*/, "")}`);

      const input = {
        project,
        claims,
        evidence,
        evidenceLinks,
        sources,
        contradictions,
        openQuestions: questions.filter((question) => question.status === "open").map((question) => question.text),
        unresolvedCriticisms: findings.map((finding) => finding.description),
        experimentSummaries: [],
        blockedWork,
        agentRunCount: await deps.store.runs.countRuns(task.projectId),
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
        version: await deps.store.reports.nextVersion(task.projectId),
        now: deps.clock.isoNow(),
      };

      const structure = buildReportStructure(input);
      const reportable = reportableClaims(input);

      const prose = await runAgent(
        synthesizer,
        {
          question: project.originalQuestion,
          claims: reportable.map((claim) => ({
            statement: claim.statement,
            status: claim.status,
            confidence: claim.confidence?.score ?? null,
            sources: structure.findings.find((finding) => finding.claimIds.includes(claim.id))?.supportingSources ?? 0,
            uncertainties: claim.confidence?.majorUncertainties ?? [],
          })),
          contradictions: contradictions.map((item) => ({
            description: item.description,
            status: item.status,
            severity: item.severity,
          })),
          openQuestions: input.openQuestions,
          criticisms: input.unresolvedCriticisms,
          statistics: {
            sourcesConsidered: structure.statistics.sourcesConsidered,
            evidenceItems: structure.statistics.evidenceItems,
            agentRuns: structure.statistics.agentRuns,
          },
          overallConfidence: structure.overallConfidence,
          blockedWork,
        },
        context,
      );

      const report = assembleReport(input, structure, prose.output, prose.runId);
      await deps.store.reports.save(report);

      await emit(deps, task.projectId, "research.report.generated", {
        reportId: report.id,
        version: report.version,
        overallConfidence: report.overallConfidence,
      });

      return completed({
        reportId: report.id,
        version: report.version,
        findings: report.keyFindings.length,
        excludedClaims: structure.excluded.length,
        overallConfidence: report.overallConfidence,
      });
    },
  };
}
