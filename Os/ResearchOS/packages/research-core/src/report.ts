/**
 * Building the report.
 *
 * The structured parts of a report — findings, citations, statistics,
 * contradictions — are assembled here from stored research state. The
 * synthesiser supplies only prose. That division is the guarantee the document
 * rests on: a citation exists because a source row exists, a finding exists
 * because a claim row exists, and a number exists because it was counted.
 *
 * Consequences worth stating plainly:
 *   - A claim with no evidence never becomes a finding, no matter how well it
 *     reads.
 *   - Contradictions are carried into the report unresolved. Averaging them away
 *     would produce a cleaner document that says something false.
 *   - Work that was blocked appears as a limitation. A report that omits what it
 *     could not do overstates what it did.
 */
import type {
  Claim, ClaimEvidenceLink, Contradiction, Evidence, ReportCitation, ReportFinding,
  ResearchProject, ResearchReport, Source,
} from "@research-os/contracts";
import { clamp01, newId, round } from "@research-os/shared";
import type { SynthesisOutput } from "./agents/synthesizer.ts";

export interface ReportInput {
  readonly project: ResearchProject;
  readonly claims: readonly Claim[];
  readonly evidence: readonly Evidence[];
  readonly evidenceLinks: readonly ClaimEvidenceLink[];
  readonly sources: readonly Source[];
  readonly contradictions: readonly Contradiction[];
  readonly openQuestions: readonly string[];
  readonly unresolvedCriticisms: readonly string[];
  readonly experimentSummaries: readonly {
    experimentId: string; title: string; outcome: string; reproducibilityScore: number | null;
  }[];
  /** Work that could not be carried out. Becomes a limitation. */
  readonly blockedWork: readonly string[];
  readonly agentRunCount: number;
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: number };
  readonly version: number;
  readonly now: string;
}

/** Claims eligible to be reported as findings. */
export function reportableClaims(input: Pick<ReportInput, "claims" | "evidenceLinks">): Claim[] {
  const linked = new Set(input.evidenceLinks.map((link) => link.claimId as string));
  return input.claims.filter(
    (claim) =>
      claim.status !== "retracted" &&
      claim.supersededByClaimId === null &&
      // The load-bearing filter: a claim nothing supports is a model assertion,
      // and printing it beside evidenced claims lends it their credibility.
      linked.has(claim.id as string),
  );
}

/**
 * Overall confidence: the evidence-weighted mean of the findings.
 *
 * Weighted rather than a plain average, so a well-evidenced claim counts for
 * more than a thinly-evidenced one. A report with no findings scores 0 — there
 * is nothing to be confident about, and 0.5 would read as "balanced".
 */
export function overallConfidence(findings: readonly ReportFinding[]): number {
  if (findings.length === 0) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const finding of findings) {
    const weight = Math.max(1, finding.supportingSources + finding.contradictingSources);
    weighted += finding.confidence * weight;
    totalWeight += weight;
  }
  return round(clamp01(weighted / totalWeight), 4);
}

/**
 * Builds citations from source rows.
 *
 * Markers are assigned in the order sources are first cited, and only sources
 * that are actually cited appear. A bibliography padded with everything the run
 * happened to fetch overstates what the conclusions rest on.
 */
export function buildCitations(
  sources: readonly Source[],
  citedSourceIds: ReadonlySet<string>,
  style: ReportCitation["style"],
): ReportCitation[] {
  return sources
    .filter((source) => citedSourceIds.has(source.id as string))
    .map((source, index) => ({
      marker: String(index + 1),
      sourceId: source.id,
      formatted: formatCitation(source, style),
      style,
      url: source.url,
      accessedAt: source.retrievedAt,
    })) as ReportCitation[];
}

/** Deliberately plain. Only fields the source row actually has are rendered. */
function formatCitation(source: Source, style: ReportCitation["style"]): string {
  const authors = source.authors.length > 0 ? source.authors.join(", ") : "No author recorded";
  const year = source.publishedAt ? new Date(source.publishedAt).getUTCFullYear() : "n.d.";
  const publisher = source.publisher ? `${source.publisher}. ` : "";
  const url = source.url ? ` ${source.url}` : "";

  return style === "apa"
    ? `${authors} (${year}). ${source.title}. ${publisher}${url}`.trim()
    : `${authors}. "${source.title}." ${publisher}${year}.${url}`.trim();
}

export interface BuiltReport {
  readonly findings: ReportFinding[];
  readonly citations: ReportCitation[];
  readonly citedSourceIds: Set<string>;
  readonly statistics: ResearchReport["statistics"];
  readonly overallConfidence: number;
  /** Claims excluded from the report, with the reason. Never silently dropped. */
  readonly excluded: { claimId: string; statement: string; reason: string }[];
}

/**
 * Assembles everything structural. Prose is added afterwards.
 *
 * Exposed separately from `assembleReport` so the structured half can be tested
 * without a model, and so a caller can see what the synthesiser will be given.
 */
export function buildReportStructure(input: ReportInput): BuiltReport {
  const style = input.project.preferences.citationStyle;
  const linksByClaim = new Map<string, ClaimEvidenceLink[]>();
  for (const link of input.evidenceLinks) {
    const existing = linksByClaim.get(link.claimId as string) ?? [];
    existing.push(link);
    linksByClaim.set(link.claimId as string, existing);
  }
  const evidenceById = new Map(input.evidence.map((item) => [item.id as string, item]));

  const excluded: BuiltReport["excluded"] = [];
  for (const claim of input.claims) {
    if (claim.status === "retracted") {
      excluded.push({ claimId: claim.id, statement: claim.statement, reason: "retracted" });
    } else if (claim.supersededByClaimId !== null) {
      excluded.push({ claimId: claim.id, statement: claim.statement, reason: "superseded by a later claim" });
    } else if (!linksByClaim.has(claim.id as string)) {
      excluded.push({ claimId: claim.id, statement: claim.statement, reason: "no supporting evidence" });
    }
  }

  const citedSourceIds = new Set<string>();
  const findings: ReportFinding[] = [];

  for (const claim of reportableClaims(input)) {
    const links = linksByClaim.get(claim.id as string) ?? [];
    const items = links.map((link) => evidenceById.get(link.evidenceId as string)).filter((item): item is Evidence => Boolean(item));
    for (const item of items) citedSourceIds.add(item.sourceId as string);

    const supporting = new Set(
      items.filter((item) => links.find((link) => link.evidenceId === item.id)?.stance === "supports").map((item) => item.sourceId as string),
    );
    const contradicting = new Set(
      items.filter((item) => links.find((link) => link.evidenceId === item.id)?.stance === "contradicts").map((item) => item.sourceId as string),
    );

    findings.push({
      statement: claim.statement,
      claimIds: [claim.id],
      // A claim whose confidence was never computed reports 0, not a guess.
      confidence: claim.confidence?.score ?? 0,
      supportingSources: supporting.size,
      contradictingSources: contradicting.size,
      replicatedExperiments: claim.confidence?.replications ?? 0,
      failedReplications: claim.confidence?.failedReplications ?? 0,
      majorUncertainties: claim.confidence?.majorUncertainties ?? [],
      citationMarkers: [],
    } as ReportFinding);
  }

  const citations = buildCitations(input.sources, citedSourceIds, style);
  const markerBySource = new Map(citations.map((citation) => [citation.sourceId as string, citation.marker]));

  // Markers are attached after citations exist, so a finding can never point at
  // a marker that is not in the bibliography.
  const withMarkers = findings.map((finding, index) => {
    const claim = reportableClaims(input)[index];
    const links = claim ? linksByClaim.get(claim.id as string) ?? [] : [];
    const markers = [...new Set(
      links
        .map((link) => evidenceById.get(link.evidenceId as string)?.sourceId as string | undefined)
        .filter((sourceId): sourceId is string => Boolean(sourceId))
        .map((sourceId) => markerBySource.get(sourceId))
        .filter((marker): marker is string => Boolean(marker)),
    )];
    return { ...finding, citationMarkers: markers };
  });

  return {
    findings: withMarkers,
    citations,
    citedSourceIds,
    overallConfidence: overallConfidence(withMarkers),
    excluded,
    statistics: {
      sourcesConsidered: input.sources.length,
      sourcesCited: citations.length,
      evidenceItems: input.evidence.length,
      claimsTotal: input.claims.length,
      claimsSupported: input.claims.filter((claim) => claim.status === "supported").length,
      claimsRefuted: input.claims.filter((claim) => claim.status === "refuted").length,
      claimsContested: input.claims.filter((claim) => claim.status === "contested").length,
      openContradictions: input.contradictions.filter((item) => item.status === "open" || item.status === "investigating").length,
      agentRuns: input.agentRunCount,
      tokensUsed: input.usage.inputTokens + input.usage.outputTokens,
      costUsd: input.usage.costUsd,
    },
  };
}

/** Joins the structured report with the synthesiser's prose. */
export function assembleReport(
  input: ReportInput,
  structure: BuiltReport,
  prose: SynthesisOutput,
  generatedByRunId: string | null,
): ResearchReport {
  const reportable = reportableClaims(input);

  return {
    id: newId("report"),
    projectId: input.project.id,
    version: input.version,
    title: prose.title,
    executiveSummary: prose.executiveSummary,
    originalQuestion: input.project.originalQuestion,
    methodology: prose.methodology,
    keyFindings: structure.findings,
    contradictions: input.contradictions.map((item) => ({
      contradictionId: item.id,
      description: item.description,
      status: item.status,
      severity: item.severity,
      candidateExplanations: item.candidateExplanations,
      resolution: item.resolution,
    })),
    overallConfidence: structure.overallConfidence,
    confidenceRationale: prose.confidenceRationale,
    // Blocked work and excluded claims are appended to whatever the synthesiser
    // wrote, so they cannot be omitted by a model that found them inconvenient.
    limitations: [
      ...prose.limitations,
      ...input.blockedWork.map((item) => `Could not be carried out: ${item}`),
      ...structure.excluded
        .filter((entry) => entry.reason === "no supporting evidence")
        .map((entry) => `Excluded from findings for lack of supporting evidence: "${entry.statement}"`),
    ],
    unansweredQuestions: [...prose.unansweredQuestions, ...input.openQuestions],
    recommendedNextResearch: prose.recommendedNextResearch,
    experimentSummaries: [...input.experimentSummaries],
    sections: prose.sections.map((section) => ({
      key: section.key,
      heading: section.heading,
      body: section.body,
      claimIds: section.claimIndices
        .map((index) => reportable[index - 1]?.id)
        .filter((id): id is Claim["id"] => Boolean(id)),
    })),
    citations: structure.citations,
    citationStyle: input.project.preferences.citationStyle,
    statistics: structure.statistics,
    generatedByRunId,
    createdAt: input.now,
  } as ResearchReport;
}
