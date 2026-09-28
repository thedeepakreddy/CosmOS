/**
 * Running every applicable check over a research artifact.
 *
 * Verification here is deliberately mechanical. There is no "is this claim
 * correct?" check, because a general correctness judgement from a model is
 * exactly the kind of unearned confidence the rest of the system works to avoid.
 * What *can* be checked mechanically — does the quote appear, do the numbers
 * match, is the claim traceable to anything at all, do two accepted claims
 * conflict — is checked exactly, and everything else is reported honestly as
 * inconclusive or not applicable.
 *
 * `inconclusive` is a real outcome, not a failure. "We could not tell" and "it
 * is wrong" are different facts, and the confidence calculation treats them
 * differently.
 */
import type {
  Claim, ClaimEvidenceLink, Evidence, Experiment, SourceChunk, VerificationCheck, VerificationCheckType,
  VerificationOutcome, VerificationSummary,
} from "@research-os/contracts";
import { detectContradictionCandidates } from "@research-os/claims";
import { newId } from "@research-os/shared";
import { checkCitationFidelity } from "./citation.ts";
import { checkArithmetic, checkNumericConsistency } from "./numeric.ts";

export interface VerificationContext {
  readonly projectId: string;
  readonly now: string;
  readonly runId?: string | null;
}

function makeCheck(
  context: VerificationContext,
  checkType: VerificationCheckType,
  targetType: VerificationCheck["targetType"],
  targetId: string,
  outcome: VerificationOutcome,
  detail: string,
  weight = 1,
): VerificationCheck {
  return {
    id: newId("verification"),
    projectId: context.projectId,
    checkType,
    targetType,
    targetId,
    outcome,
    detail: detail.slice(0, 4000),
    weight,
    // Null because no model was involved. A check that *did* use one records
    // which provider, so independence can be proven rather than asserted.
    verifierProvider: null,
    verifiedByRunId: context.runId ?? null,
    createdAt: context.now,
  } as VerificationCheck;
}

/**
 * Verifies one evidence item against the chunks it was extracted from.
 *
 * A `paraphrased` verdict is a *failure*, not a warning. Evidence that presents
 * a paraphrase as a quotation is the failure mode that makes an entire report
 * untrustworthy, because every downstream reader assumes quotation marks mean
 * quotation.
 */
export function verifyEvidence(
  evidence: Evidence,
  chunks: readonly SourceChunk[],
  context: VerificationContext,
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  const cited = chunks.filter((chunk) => evidence.chunkIds.includes(chunk.id));
  const searchable = cited.length > 0 ? cited : chunks;

  if (searchable.length === 0) {
    checks.push(makeCheck(
      context, "citation_fidelity", "evidence", evidence.id, "inconclusive",
      "No stored chunk was available to check the quote against. The quote is unverified, not disproven.",
    ));
    return checks;
  }

  const best = searchable
    .map((chunk) => checkCitationFidelity(evidence.quote, chunk.text))
    .reduce((a, b) => (b.similarity > a.similarity ? b : a));

  const outcome: VerificationOutcome =
    best.verdict === "exact" || best.verdict === "elided" || best.verdict === "near" ? "passed" : "failed";

  checks.push(makeCheck(
    context, "citation_fidelity", "evidence", evidence.id, outcome, best.detail,
    // A quote that is absent entirely is a heavier signal than one that is
    // merely a loose transcription.
    best.verdict === "absent" ? 1 : 0.8,
  ));

  if (cited.length === 0) {
    checks.push(makeCheck(
      context, "citation_resolvable", "evidence", evidence.id, "inconclusive",
      "This evidence names no chunk, so the quote was checked against the whole source rather than the passage it claims.",
      0.5,
    ));
  }

  return checks;
}

export interface ClaimVerificationInput {
  readonly claim: Claim;
  readonly evidence: readonly Evidence[];
  /** Other claims already accepted in this project, for consistency checking. */
  readonly acceptedClaims?: readonly Claim[];
  /**
   * Claim-to-evidence links across the project.
   *
   * Passed through to contradiction detection, where the strongest signal is a
   * fact about the graph rather than about the prose: two claims citing the
   * same evidence with opposite stances cannot both be right, regardless of how
   * their sentences read.
   */
  readonly evidenceLinks?: readonly ClaimEvidenceLink[];
}

export function verifyClaim(input: ClaimVerificationInput, context: VerificationContext): VerificationCheck[] {
  const { claim, evidence } = input;
  const checks: VerificationCheck[] = [];

  // Traceability first: a claim resting on nothing fails here, and every other
  // check on it is then beside the point.
  checks.push(
    evidence.length === 0
      ? makeCheck(
          context, "evidence_traceability", "claim", claim.id, "failed",
          "This claim cites no evidence. It is a model assertion, not a finding.",
        )
      : makeCheck(
          context, "evidence_traceability", "claim", claim.id, "passed",
          `Traceable to ${evidence.length} evidence item(s) across ${new Set(evidence.map((item) => item.sourceId)).size} source(s).`,
        ),
  );

  const numeric = checkNumericConsistency(claim.statement, evidence.map((item) => item.quote));
  if (numeric.outcome !== "not_applicable") {
    checks.push(makeCheck(context, "numeric_consistency", "claim", claim.id, numeric.outcome, numeric.detail));
  }

  const arithmetic = checkArithmetic(claim.statement);
  if (arithmetic.length > 0) {
    const wrong = arithmetic.filter((statement) => !statement.correct);
    checks.push(makeCheck(
      context, "arithmetic", "claim", claim.id,
      wrong.length === 0 ? "passed" : "failed",
      wrong.length === 0
        ? `Checked ${arithmetic.length} arithmetic statement(s); all hold.`
        : wrong.map((statement) => `"${statement.expression}" states ${statement.stated}, computes to ${statement.computed}`).join("; "),
    ));
  }

  checks.push(checkScopeSupport(claim, evidence, context));

  const accepted = input.acceptedClaims ?? [];
  if (accepted.length > 0) {
    const candidates = detectContradictionCandidates([claim, ...accepted], input.evidenceLinks ?? []);
    const involving = candidates.filter(
      (candidate) => candidate.claimIdA === claim.id || candidate.claimIdB === claim.id,
    );
    checks.push(makeCheck(
      context, "internal_consistency", "claim", claim.id,
      involving.length === 0 ? "passed" : "failed",
      involving.length === 0
        ? `No conflict found against ${accepted.length} accepted claim(s).`
        : `Conflicts with ${involving.length} accepted claim(s): ${involving.map((candidate) => candidate.kind).join(", ")}.`,
    ));
  }

  return checks;
}

const UNIVERSAL_QUANTIFIERS = /\b(all|every|always|never|none|no one|universally|invariably|in every case)\b/i;
const HEDGES = /\b(may|might|could|suggests?|indicates?|appears?|likely|in some|often|typically|generally)\b/i;

/**
 * Does the claim assert more than its evidence can carry?
 *
 * A universal claim ("memory always improves recall") cannot be established by a
 * handful of studies, and this is a failure mode that survives review because
 * the sentence reads confidently. The check is narrow — quantifier words against
 * evidence count — and reports `inconclusive` rather than guessing when the
 * claim is hedged.
 */
function checkScopeSupport(claim: Claim, evidence: readonly Evidence[], context: VerificationContext): VerificationCheck {
  const universal = UNIVERSAL_QUANTIFIERS.test(claim.statement);
  const hedged = HEDGES.test(claim.statement);
  const distinctSources = new Set(evidence.map((item) => item.sourceId)).size;

  if (!universal) {
    return makeCheck(
      context, "scope_support", "claim", claim.id, "passed",
      hedged
        ? "The claim is hedged and does not assert more than its evidence supports."
        : "The claim makes no universal assertion.",
      0.5,
    );
  }

  return distinctSources >= 3
    ? makeCheck(
        context, "scope_support", "claim", claim.id, "inconclusive",
        `The claim is universal in scope ("all", "every", "always"). ${distinctSources} independent sources is substantial but does not establish a universal.`,
        0.5,
      )
    : makeCheck(
        context, "scope_support", "claim", claim.id, "failed",
        `The claim asserts a universal but rests on ${distinctSources} source(s). Narrow the scope or gather more evidence.`,
        0.8,
      );
}

/**
 * Could someone else re-run this experiment?
 *
 * Checks the recorded environment, not the result. An experiment whose
 * interpreter version was never captured produced a number nobody can check,
 * which for research purposes is not a result.
 */
export function verifyExperiment(experiment: Experiment, context: VerificationContext): VerificationCheck[] {
  const missing: string[] = [];
  if (!experiment.environment.runtimeVersion) missing.push("runtime version");
  if (experiment.environment.dependencies.length === 0) missing.push("pinned dependencies");
  if (!experiment.environment.platform) missing.push("platform");
  if (experiment.code.trim().length === 0) missing.push("code");

  const stochastic = /random|shuffle|sample|seed|stochastic|monte.?carlo/i.test(experiment.code);
  if (stochastic && experiment.environment.randomSeed === null) missing.push("random seed (the code appears stochastic)");

  return [
    missing.length === 0
      ? makeCheck(
          context, "reproducibility", "experiment", experiment.id, "passed",
          "The recorded environment is complete enough for a re-run.",
        )
      : makeCheck(
          context, "reproducibility", "experiment", experiment.id, "failed",
          `Not reproducible as recorded. Missing: ${missing.join(", ")}.`,
        ),
  ];
}

/**
 * Aggregates checks into a summary.
 *
 * Inconclusive checks are excluded from the pass rate rather than counted as
 * failures. "We could not tell" is not the same as "it is wrong", and averaging
 * them together would make an unverifiable claim look refuted.
 */
export function summariseChecks(
  targetType: string,
  targetId: string,
  checks: readonly VerificationCheck[],
): VerificationSummary {
  const relevant = checks.filter((check) => check.targetId === targetId);
  const passed = relevant.filter((check) => check.outcome === "passed").length;
  const failed = relevant.filter((check) => check.outcome === "failed").length;
  const inconclusive = relevant.filter((check) => check.outcome === "inconclusive").length;
  const decisive = passed + failed;

  return {
    targetType,
    targetId,
    total: relevant.length,
    passed,
    failed,
    inconclusive,
    passRate: decisive === 0 ? null : passed / decisive,
    failedCheckTypes: [...new Set(relevant.filter((check) => check.outcome === "failed").map((check) => check.checkType))],
  };
}

/**
 * Checks whose failure should block a claim from being reported as supported.
 *
 * A quote that does not exist and a claim that cites nothing are not
 * "considerations" — they invalidate the finding, and a report that presents
 * such a claim alongside properly evidenced ones misleads by association.
 */
export const BLOCKING_CHECK_TYPES: readonly VerificationCheckType[] = ["citation_fidelity", "evidence_traceability"];

export function hasBlockingFailure(checks: readonly VerificationCheck[]): boolean {
  return checks.some((check) => check.outcome === "failed" && BLOCKING_CHECK_TYPES.includes(check.checkType));
}
