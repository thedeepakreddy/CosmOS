/**
 * Scoring the quality of a research project.
 *
 * Not "is the answer right?" — nothing here knows that, and a system that
 * claimed to would be the most dangerous component in the codebase. This scores
 * whether the research was *conducted well*: is every conclusion traceable, was
 * it checked, was disagreement preserved, does the confidence match the
 * evidence, and did anyone look for the answer being wrong.
 *
 * A project can score badly while being correct, and score well while being
 * wrong. That is the honest limit of what an automated rubric can see, and it is
 * stated here so nobody mistakes a high score for a verdict on the findings.
 *
 * Every dimension is arithmetic over stored artifacts. No model is asked to
 * grade the work — a model scoring research produced by models is a closed loop
 * that mostly measures how convincing the output reads.
 */
import type {
  Claim, ClaimEvidenceLink, Contradiction, CritiqueFinding, Evidence, ResearchReport, Source,
  VerificationCheck,
} from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

export const EVALUATION_DIMENSIONS = [
  /** Does every reported finding trace to evidence, and evidence to a source? */
  "traceability",
  /** Were quotes and figures mechanically checked, and did they pass? */
  "verification",
  /** How many genuinely independent sources underpin the conclusions? */
  "evidenceBreadth",
  /** Was the research attacked, and were the objections resolved or recorded? */
  "criticalScrutiny",
  /** Are contradictions preserved and explained rather than averaged away? */
  "contradictionHandling",
  /** Does stated confidence match the weight of evidence behind it? */
  "calibration",
  /** Are limitations, blocked work and open questions stated? */
  "transparency",
  /** Could someone else repeat what was done? */
  "reproducibility",
] as const;
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

/**
 * Weights.
 *
 * Traceability and verification carry the most because they are what separate
 * research from generated prose. Breadth matters but is bounded — ten sources
 * that all restate one study is not breadth, and the independence discount in
 * the confidence calculation already knows that.
 */
export const DIMENSION_WEIGHTS: Readonly<Record<EvaluationDimension, number>> = {
  traceability: 0.22,
  verification: 0.2,
  evidenceBreadth: 0.12,
  criticalScrutiny: 0.12,
  contradictionHandling: 0.1,
  calibration: 0.12,
  transparency: 0.07,
  reproducibility: 0.05,
};

export interface DimensionScore {
  readonly dimension: EvaluationDimension;
  readonly score: number;
  /** What was counted, in terms someone can check against the data. */
  readonly detail: string;
  /** Null when the project contains nothing this dimension applies to. */
  readonly applicable: boolean;
}

export interface EvaluationInput {
  readonly claims: readonly Claim[];
  readonly evidence: readonly Evidence[];
  readonly evidenceLinks: readonly ClaimEvidenceLink[];
  readonly sources: readonly Source[];
  readonly contradictions: readonly Contradiction[];
  readonly findings: readonly CritiqueFinding[];
  readonly verificationChecks: readonly VerificationCheck[];
  readonly report: ResearchReport | null;
  /** Task types that ran, so the rubric can see whether critique happened at all. */
  readonly completedTaskTypes: readonly string[];
  readonly blockedWork: readonly string[];
  readonly experimentReproducibility: readonly number[];
}

export interface EvaluationResult {
  readonly overall: number;
  /**
   * `unevaluable` is distinct from `weak` on purpose.
   *
   * A project with no claims, no evidence and no report has not been assessed
   * and found wanting — there was nothing to assess. Grading it `weak` would be
   * a judgement the rubric did not make.
   */
  readonly grade: "strong" | "adequate" | "weak" | "unsound" | "unevaluable";
  readonly dimensions: DimensionScore[];
  /** Specific, actionable problems, worst first. */
  readonly weaknesses: string[];
  /** Things that must be true for the result to be usable at all. */
  readonly blockers: string[];
  readonly summary: string;
}

const NOT_APPLICABLE = (dimension: EvaluationDimension, detail: string): DimensionScore => ({
  dimension, score: 0, detail, applicable: false,
});

/**
 * Fraction of reported findings that reach a source.
 *
 * The single most important dimension. A finding with no evidence behind it is a
 * model assertion, and one printed beside evidenced findings borrows their
 * credibility.
 */
function scoreTraceability(input: EvaluationInput): DimensionScore {
  const reported = input.report?.keyFindings ?? [];
  if (reported.length === 0) {
    return NOT_APPLICABLE("traceability", "No report has been generated, so nothing has been asserted to trace.");
  }

  const linkedClaims = new Set(input.evidenceLinks.map((link) => link.claimId as string));
  const evidenceById = new Map(input.evidence.map((item) => [item.id as string, item]));
  const sourceIds = new Set(input.sources.map((source) => source.id as string));

  let traced = 0;
  for (const finding of reported) {
    const hasEvidence = finding.claimIds.some((claimId) => linkedClaims.has(claimId));
    const reachesSource = input.evidenceLinks
      .filter((link) => finding.claimIds.includes(link.claimId as never))
      .some((link) => {
        const item = evidenceById.get(link.evidenceId as string);
        return item ? sourceIds.has(item.sourceId as string) : false;
      });
    if (hasEvidence && reachesSource) traced++;
  }

  const score = traced / reported.length;
  return {
    dimension: "traceability",
    score: round(score, 4),
    applicable: true,
    detail: `${traced} of ${reported.length} reported findings trace through evidence to a stored source.`,
  };
}

/**
 * Whether the work was checked, and whether it passed.
 *
 * Coverage and pass rate are combined because either alone is misleading: a
 * project that checked one item and passed scores 100% on pass rate, and one
 * that checked everything and failed scores 100% on coverage.
 */
function scoreVerification(input: EvaluationInput): DimensionScore {
  const checkable = input.evidence.length + input.claims.length;
  if (checkable === 0) {
    return NOT_APPLICABLE("verification", "The project contains no evidence or claims to check.");
  }

  const checked = new Set(input.verificationChecks.map((check) => check.targetId));
  const coverage = clamp01(checked.size / checkable);

  const decisive = input.verificationChecks.filter((check) => check.outcome === "passed" || check.outcome === "failed");
  const passed = decisive.filter((check) => check.outcome === "passed").length;
  // Inconclusive checks are excluded: "we could not tell" is not "it is wrong".
  const passRate = decisive.length === 0 ? 0 : passed / decisive.length;

  const score = decisive.length === 0 ? 0 : coverage * 0.4 + passRate * 0.6;
  return {
    dimension: "verification",
    score: round(clamp01(score), 4),
    applicable: true,
    detail: `${checked.size} of ${checkable} artifacts checked; ${passed} of ${decisive.length} decisive checks passed` +
      `${input.verificationChecks.length - decisive.length > 0 ? `, ${input.verificationChecks.length - decisive.length} inconclusive` : ""}.`,
  };
}

/**
 * Independent sources behind the conclusions.
 *
 * Counted by registrable domain, not by source row. Five papers from one group
 * are closer to one source than to five, and counting rows would reward
 * quantity over independence — exactly the error the confidence calculation's
 * independence discount exists to prevent.
 *
 * Saturates: beyond six independent domains, more breadth adds little, and a
 * dimension that never saturates would let volume compensate for poor
 * traceability.
 */
function scoreEvidenceBreadth(input: EvaluationInput): DimensionScore {
  if (input.claims.length === 0) {
    return NOT_APPLICABLE("evidenceBreadth", "The project has no claims, so there is no evidence base to measure.");
  }

  const citedSourceIds = new Set(
    input.evidenceLinks
      .map((link) => input.evidence.find((item) => item.id === link.evidenceId)?.sourceId as string | undefined)
      .filter((id): id is string => Boolean(id)),
  );
  const domains = new Set(
    [...citedSourceIds]
      .map((id) => input.sources.find((source) => source.id === id))
      .map((source) => source?.domain ?? source?.id ?? "unknown"),
  );

  const saturationPoint = 6;
  const score = clamp01(domains.size / saturationPoint);
  return {
    dimension: "evidenceBreadth",
    score: round(score, 4),
    applicable: true,
    detail: `${domains.size} independent domain(s) across ${citedSourceIds.size} cited source(s).`,
  };
}

/** Was anyone looking for the research being wrong, and what happened to what they found? */
function scoreCriticalScrutiny(input: EvaluationInput): DimensionScore {
  // Nothing was concluded, so there was nothing to attack. Scoring zero here
  // would penalise a project for failing to critique claims it never made,
  // which is the same inconsistency the other dimensions avoid.
  if (input.claims.length === 0) {
    return NOT_APPLICABLE("criticalScrutiny", "The project reached no claims, so there was nothing to scrutinise.");
  }

  const critiqued = input.completedTaskTypes.includes("critique.run");
  const debated = input.completedTaskTypes.includes("debate.run");

  if (!critiqued && !debated) {
    return {
      dimension: "criticalScrutiny",
      score: 0,
      applicable: true,
      detail: "No critique or debate was run. Nothing looked for the research being wrong.",
    };
  }

  const open = input.findings.filter((finding) => finding.status === "open");
  const severeOpen = open.filter((finding) => finding.severity >= 0.7);

  // Raising objections is most of the value; leaving severe ones unaddressed
  // costs, but a recorded open objection is still far better than none raised.
  const base = critiqued ? 0.6 : 0.4;
  const debateBonus = debated ? 0.2 : 0;
  const severePenalty = Math.min(0.4, severeOpen.length * 0.15);

  return {
    dimension: "criticalScrutiny",
    score: round(clamp01(base + debateBonus + (input.findings.length > 0 ? 0.2 : 0) - severePenalty), 4),
    applicable: true,
    detail: `${input.findings.length} finding(s) raised, ${open.length} still open (${severeOpen.length} severe)` +
      `${debated ? "; an adversarial debate was run" : ""}.`,
  };
}

/** Contradictions are findings. Averaging them away scores zero. */
function scoreContradictionHandling(input: EvaluationInput): DimensionScore {
  if (input.contradictions.length === 0) {
    return NOT_APPLICABLE("contradictionHandling", "No contradictions were detected.");
  }

  const resolved = input.contradictions.filter((item) => item.status === "resolved" || item.status === "irreconcilable");
  const explained = input.contradictions.filter(
    (item) => item.resolution !== null || item.candidateExplanations.length > 0,
  );
  const inReport = new Set((input.report?.contradictions ?? []).map((item) => item.contradictionId as string));
  const carried = input.contradictions.filter((item) => inReport.has(item.id as string));

  // Carrying a contradiction into the report unresolved scores well. Resolving
  // it scores better. Dropping it silently scores nothing, which is the point.
  const score = input.report
    ? (carried.length / input.contradictions.length) * 0.5 +
      (explained.length / input.contradictions.length) * 0.3 +
      (resolved.length / input.contradictions.length) * 0.2
    : (explained.length / input.contradictions.length) * 0.6;

  return {
    dimension: "contradictionHandling",
    score: round(clamp01(score), 4),
    applicable: true,
    detail: `${input.contradictions.length} contradiction(s): ${carried.length} carried into the report, ` +
      `${explained.length} with candidate explanations, ${resolved.length} resolved.`,
  };
}

/**
 * Does stated confidence match the evidence behind it?
 *
 * Miscalibration in either direction is penalised. A claim asserted at 0.9 on
 * one source overstates; a claim held at 0.3 despite six independent
 * corroborations understates and buries a real finding.
 */
function scoreCalibration(input: EvaluationInput): DimensionScore {
  const scored = input.claims.filter((claim) => claim.confidence !== null);
  if (scored.length === 0) {
    return NOT_APPLICABLE("calibration", "No claim has a computed confidence.");
  }

  let penalty = 0;
  const problems: string[] = [];

  for (const claim of scored) {
    const breakdown = claim.confidence!;
    const independent = breakdown.distinctDomains;
    const score = breakdown.score;

    if (score >= 0.8 && independent <= 1) {
      penalty += 1;
      problems.push(`"${claim.statement.slice(0, 60)}…" is held at ${score.toFixed(2)} on ${independent} independent domain(s)`);
    } else if (score <= 0.35 && independent >= 4 && breakdown.effectiveContradictingCount < breakdown.effectiveSupportingCount) {
      penalty += 0.5;
      problems.push(`"${claim.statement.slice(0, 60)}…" is held at ${score.toFixed(2)} despite ${independent} corroborating domains`);
    }

    // A reported interval of zero width claims certainty the evidence cannot
    // support, whatever the score is.
    const [low, high] = breakdown.uncertaintyInterval;
    if (high - low < 0.01 && breakdown.effectiveSupportingCount + breakdown.effectiveContradictingCount < 10) {
      penalty += 0.5;
    }
  }

  const score = clamp01(1 - penalty / scored.length);
  return {
    dimension: "calibration",
    score: round(score, 4),
    applicable: true,
    detail: problems.length === 0
      ? `All ${scored.length} scored claim(s) have confidence consistent with their evidence base.`
      : `${problems.length} miscalibrated claim(s): ${problems.slice(0, 3).join("; ")}.`,
  };
}

/** Does the report say what it could not do? */
function scoreTransparency(input: EvaluationInput): DimensionScore {
  if (!input.report) {
    return NOT_APPLICABLE("transparency", "No report has been generated.");
  }

  const hasLimitations = input.report.limitations.length > 0;
  const hasOpenQuestions = input.report.unansweredQuestions.length > 0;
  const hasRationale = input.report.confidenceRationale.trim().length > 0;
  const blockedDeclared = input.blockedWork.length === 0 ||
    input.report.limitations.some((limitation) => /could not be carried out|blocked/i.test(limitation));

  const parts = [hasLimitations, hasOpenQuestions, hasRationale, blockedDeclared];
  const score = parts.filter(Boolean).length / parts.length;

  const missing: string[] = [];
  if (!hasLimitations) missing.push("no limitations stated");
  if (!hasOpenQuestions) missing.push("no open questions stated");
  if (!hasRationale) missing.push("no confidence rationale");
  if (!blockedDeclared) missing.push(`${input.blockedWork.length} blocked task(s) not declared as limitations`);

  return {
    dimension: "transparency",
    score: round(score, 4),
    applicable: true,
    detail: missing.length === 0 ? "Limitations, open questions and confidence rationale are all stated." : missing.join("; ") + ".",
  };
}

/** Could someone repeat the experiments? Not applicable when there were none. */
function scoreReproducibility(input: EvaluationInput): DimensionScore {
  if (input.experimentReproducibility.length === 0) {
    return NOT_APPLICABLE("reproducibility", "No experiments were run.");
  }
  const mean = input.experimentReproducibility.reduce((total, value) => total + value, 0) / input.experimentReproducibility.length;
  return {
    dimension: "reproducibility",
    score: round(clamp01(mean), 4),
    applicable: true,
    detail: `${input.experimentReproducibility.length} experiment(s), mean reproducibility ${mean.toFixed(2)}.`,
  };
}

/**
 * Scores a project.
 *
 * Inapplicable dimensions are excluded and their weight redistributed, rather
 * than scored zero. A project with no experiments is not worse research for it,
 * and scoring the absence would make every literature review look unsound.
 */
export function evaluateProject(input: EvaluationInput): EvaluationResult {
  const dimensions: DimensionScore[] = [
    scoreTraceability(input),
    scoreVerification(input),
    scoreEvidenceBreadth(input),
    scoreCriticalScrutiny(input),
    scoreContradictionHandling(input),
    scoreCalibration(input),
    scoreTransparency(input),
    scoreReproducibility(input),
  ];

  const applicable = dimensions.filter((dimension) => dimension.applicable);
  const totalWeight = applicable.reduce((total, dimension) => total + DIMENSION_WEIGHTS[dimension.dimension], 0);
  const overall = totalWeight === 0
    ? 0
    : round(clamp01(applicable.reduce((total, dimension) => total + dimension.score * DIMENSION_WEIGHTS[dimension.dimension], 0) / totalWeight), 4);

  /*
   * Blockers are not weighted into the score — they invalidate it.
   *
   * A report whose findings do not trace to sources is not "research that
   * scored 0.4"; it is research whose conclusions cannot be checked, and
   * averaging that with a good transparency score would produce a number that
   * reads acceptable.
   */
  const blockers: string[] = [];
  const traceability = dimensions.find((dimension) => dimension.dimension === "traceability");
  if (traceability?.applicable && traceability.score < 1) {
    blockers.push(`Not every reported finding traces to a source: ${traceability.detail}`);
  }
  const verification = dimensions.find((dimension) => dimension.dimension === "verification");
  const failedFidelity = input.verificationChecks.filter(
    (check) => check.checkType === "citation_fidelity" && check.outcome === "failed",
  );
  if (failedFidelity.length > 0) {
    blockers.push(`${failedFidelity.length} quotation(s) could not be found in the source they cite.`);
  }
  if (verification?.applicable && input.verificationChecks.length === 0) {
    blockers.push("Nothing was verified. No quote or figure was checked against its source.");
  }

  const weaknesses = applicable
    .filter((dimension) => dimension.score < 0.6)
    .sort((a, b) => a.score - b.score)
    .map((dimension) => `${dimension.dimension} (${dimension.score.toFixed(2)}): ${dimension.detail}`);

  const grade: EvaluationResult["grade"] =
    applicable.length === 0
      ? "unevaluable"
      : blockers.length > 0 ? "unsound" : overall >= 0.8 ? "strong" : overall >= 0.6 ? "adequate" : "weak";

  return {
    overall,
    grade,
    dimensions,
    weaknesses,
    blockers,
    summary: buildSummary(grade, overall, applicable.length, blockers, weaknesses),
  };
}

function buildSummary(
  grade: EvaluationResult["grade"],
  overall: number,
  applicableCount: number,
  blockers: readonly string[],
  weaknesses: readonly string[],
): string {
  if (applicableCount === 0) {
    return "Unevaluable: this project contains no claims, evidence or report. There is nothing to assess, " +
      "which is not the same as assessing it and finding it wanting.";
  }
  if (blockers.length > 0) {
    return `Unsound: ${blockers[0]} The overall score of ${overall.toFixed(2)} across ${applicableCount} applicable dimension(s) ` +
      "should not be read as a quality rating while that holds.";
  }
  const lead = `${grade[0]?.toUpperCase()}${grade.slice(1)} (${overall.toFixed(2)} across ${applicableCount} applicable dimension(s)).`;
  return weaknesses.length === 0
    ? `${lead} No dimension scored below 0.6.`
    : `${lead} Weakest: ${weaknesses[0]}`;
}

/**
 * What this rubric cannot see.
 *
 * Returned with every evaluation so a consumer is never left to infer that a
 * high score means the findings are correct.
 */
export const EVALUATION_CAVEATS: readonly string[] = [
  "This scores how the research was conducted, not whether its conclusions are true.",
  "A well-conducted project can reach a wrong answer, and a badly-conducted one can reach a right one.",
  "Source quality is judged from deterministic signals and recorded assessments, not from reading the sources.",
  "Independence is approximated by registrable domain; two groups publishing on one domain count as one.",
];
