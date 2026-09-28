import { z } from "zod";
import { idSchema, idRefSchema, IsoDateTime, UnitInterval, CitationStyle } from "./primitives.ts";

/**
 * Research reports.
 *
 * A report is generated from structured research state — claims, evidence,
 * contradictions, experiments — and not from a conversation transcript. Every
 * assertion in a report carries the claim ids it came from, so a reader can
 * open any sentence and see what it rests on.
 */

export const ReportCitation = z.object({
  /** Stable marker used in the body text, e.g. "1" for "[1]". */
  marker: z.string().max(20),
  sourceId: idRefSchema("source"),
  formatted: z.string().max(2000),
  style: CitationStyle,
  url: z.string().max(2000).nullable(),
  accessedAt: IsoDateTime.nullable(),
});
export type ReportCitation = z.infer<typeof ReportCitation>;

export const ReportFinding = z.object({
  statement: z.string().min(1).max(2000),
  /** Claims backing this finding. A finding with no claim ids is a bug. */
  claimIds: z.array(idRefSchema("claim")).min(1),
  confidence: UnitInterval,
  /** Counts lifted from the confidence breakdown, for at-a-glance reading. */
  supportingSources: z.number().int().nonnegative(),
  contradictingSources: z.number().int().nonnegative(),
  replicatedExperiments: z.number().int().nonnegative(),
  failedReplications: z.number().int().nonnegative(),
  majorUncertainties: z.array(z.string().max(500)).default([]),
  citationMarkers: z.array(z.string().max(20)).default([]),
});
export type ReportFinding = z.infer<typeof ReportFinding>;

export const ReportContradiction = z.object({
  contradictionId: idRefSchema("contradiction"),
  description: z.string().max(4000),
  status: z.string().max(50),
  severity: UnitInterval,
  candidateExplanations: z.array(z.string().max(2000)).default([]),
  resolution: z.string().max(4000).nullable(),
});
export type ReportContradiction = z.infer<typeof ReportContradiction>;

export const ReportSection = z.object({
  key: z.string().max(100),
  heading: z.string().max(300),
  /** Markdown. Citation markers appear inline as [n]. */
  body: z.string(),
  claimIds: z.array(idRefSchema("claim")).default([]),
});
export type ReportSection = z.infer<typeof ReportSection>;

export const ResearchReport = z.object({
  id: idSchema("report"),
  projectId: idSchema("project"),
  version: z.number().int().positive(),
  title: z.string().max(500),

  executiveSummary: z.string(),
  originalQuestion: z.string(),
  /** How the research was actually conducted, derived from the task log. */
  methodology: z.string(),

  keyFindings: z.array(ReportFinding),
  contradictions: z.array(ReportContradiction).default([]),

  /** Confidence across the whole report, derived from its findings. */
  overallConfidence: UnitInterval,
  confidenceRationale: z.string().max(4000),

  limitations: z.array(z.string().max(2000)).default([]),
  unansweredQuestions: z.array(z.string().max(2000)).default([]),
  recommendedNextResearch: z.array(
    z.object({ direction: z.string().max(2000), rationale: z.string().max(2000), priority: UnitInterval }),
  ).default([]),

  experimentSummaries: z.array(
    z.object({
      experimentId: idRefSchema("experiment"),
      title: z.string().max(500),
      outcome: z.string().max(4000),
      reproducibilityScore: UnitInterval.nullable(),
    }),
  ).default([]),

  sections: z.array(ReportSection).default([]),
  citations: z.array(ReportCitation).default([]),
  citationStyle: CitationStyle,

  /** Raw counts, so a client can render provenance without extra calls. */
  statistics: z.object({
    sourcesConsidered: z.number().int().nonnegative(),
    sourcesCited: z.number().int().nonnegative(),
    evidenceItems: z.number().int().nonnegative(),
    claimsTotal: z.number().int().nonnegative(),
    claimsSupported: z.number().int().nonnegative(),
    claimsRefuted: z.number().int().nonnegative(),
    claimsContested: z.number().int().nonnegative(),
    openContradictions: z.number().int().nonnegative(),
    agentRuns: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),

  generatedByRunId: idRefSchema("agentRun").nullable(),
  createdAt: IsoDateTime,
});
export type ResearchReport = z.infer<typeof ResearchReport>;
