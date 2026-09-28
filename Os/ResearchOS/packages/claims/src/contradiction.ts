/**
 * Contradiction detection.
 *
 * Semantic contradiction detection needs a language model, but handing every
 * pair of claims to one is both expensive and unreliable — models will invent
 * conflicts if asked to look for them. So this module does the half that can be
 * done deterministically: it generates *candidates* using structural signals
 * that are hard to fake, and leaves adjudication to the critic agent.
 *
 * The division matters. A candidate produced here is a fact about the data
 * ("these two claims cite the same evidence item with opposite stances"). The
 * model's job is only to say whether that fact amounts to a contradiction.
 */
import type { Claim, ClaimEvidenceLink, ContradictionKind } from "@research-os/contracts";
import { clamp01, jaccardSimilarity, round, tokenizeWords } from "@research-os/shared";

export interface ContradictionCandidate {
  readonly claimIdA: string;
  readonly claimIdB: string;
  readonly kind: ContradictionKind;
  /** How strongly the structural signal suggests a conflict, in [0,1]. */
  readonly signalStrength: number;
  /** The observable fact that triggered this candidate. */
  readonly evidence: string;
}

const NEGATION_MARKERS = [
  "not",
  "no",
  "never",
  "without",
  "fails",
  "failed",
  "absent",
  "lacks",
  "cannot",
  "unable",
  "neither",
  "none",
  "decreases",
  "reduces",
  "worsens",
  "harms",
  "degrades",
];

const DIRECTION_PAIRS: readonly (readonly [string, string])[] = [
  ["increases", "decreases"],
  ["improves", "worsens"],
  ["improves", "degrades"],
  ["higher", "lower"],
  ["faster", "slower"],
  ["more", "less"],
  ["positive", "negative"],
  ["helps", "harms"],
  ["outperforms", "underperforms"],
  ["significant", "insignificant"],
];

function negationCount(words: readonly string[]): number {
  return words.filter((word) => NEGATION_MARKERS.includes(word)).length;
}

/** Numbers with their units, used to spot incompatible magnitudes. */
function extractQuantities(text: string): { value: number; unit: string }[] {
  const matches = text.matchAll(/(-?\d+(?:\.\d+)?)\s*(%|percent|x|×|ms|s|seconds|minutes|hours|points|pp)?/gi);
  const results: { value: number; unit: string }[] = [];
  for (const match of matches) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    results.push({ value, unit: (match[2] ?? "").toLowerCase().replace("percent", "%").replace("×", "x") });
  }
  return results;
}

/** Subject overlap. Two claims about different things cannot contradict each other. */
const MIN_SUBJECT_OVERLAP = 0.35;

export interface DetectOptions {
  /** Claims below this confidence are skipped — no point adjudicating noise. */
  readonly minConfidence?: number;
  readonly maxCandidates?: number;
}

/**
 * Finds structurally suspicious claim pairs.
 *
 * Three signals, in descending reliability:
 *   1. Shared evidence cited with opposite stances — a fact about the graph.
 *   2. High subject overlap with opposing direction words.
 *   3. High subject overlap with incompatible quantities.
 */
export function detectContradictionCandidates(
  claims: readonly Claim[],
  evidenceLinks: readonly ClaimEvidenceLink[],
  options: DetectOptions = {},
): ContradictionCandidate[] {
  const minConfidence = options.minConfidence ?? 0;
  const eligible = claims.filter(
    (claim) => claim.status !== "retracted" && (claim.confidence?.score ?? 1) >= minConfidence,
  );

  const stanceByClaim = new Map<string, Map<string, string>>();
  for (const link of evidenceLinks) {
    let inner = stanceByClaim.get(link.claimId);
    if (!inner) {
      inner = new Map();
      stanceByClaim.set(link.claimId, inner);
    }
    inner.set(link.evidenceId, link.stance);
  }

  const wordsByClaim = new Map<string, string[]>();
  for (const claim of eligible) wordsByClaim.set(claim.id, tokenizeWords(claim.statement));

  const candidates: ContradictionCandidate[] = [];

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      if (!a || !b) continue;

      const wordsA = wordsByClaim.get(a.id) ?? [];
      const wordsB = wordsByClaim.get(b.id) ?? [];
      const overlap = jaccardSimilarity(wordsA, wordsB);

      // Signal 1: the same evidence item cited with opposing stances. This is a
      // graph fact and does not require the statements to look similar.
      const stancesA = stanceByClaim.get(a.id);
      const stancesB = stanceByClaim.get(b.id);
      if (stancesA && stancesB) {
        for (const [evidenceId, stanceA] of stancesA) {
          const stanceB = stancesB.get(evidenceId);
          if (!stanceB) continue;
          if (
            (stanceA === "supports" && stanceB === "contradicts") ||
            (stanceA === "contradicts" && stanceB === "supports")
          ) {
            candidates.push({
              claimIdA: a.id,
              claimIdB: b.id,
              kind: "methodological_disagreement",
              signalStrength: round(clamp01(0.6 + overlap * 0.4)),
              evidence: `Evidence ${evidenceId} is cited as "${stanceA}" for one claim and "${stanceB}" for the other.`,
            });
            break;
          }
        }
      }

      if (overlap < MIN_SUBJECT_OVERLAP) continue;

      // Signal 2: same subject, opposing direction words.
      const setA = new Set(wordsA);
      const setB = new Set(wordsB);
      let directionConflict: string | undefined;
      for (const [positive, negative] of DIRECTION_PAIRS) {
        if ((setA.has(positive) && setB.has(negative)) || (setA.has(negative) && setB.has(positive))) {
          directionConflict = `"${positive}" vs "${negative}"`;
          break;
        }
      }
      const negationDelta = Math.abs(negationCount(wordsA) - negationCount(wordsB));
      if (directionConflict || negationDelta > 0) {
        candidates.push({
          claimIdA: a.id,
          claimIdB: b.id,
          kind: directionConflict ? "incompatible_direction" : "direct_negation",
          signalStrength: round(clamp01(overlap * (directionConflict ? 1 : 0.75))),
          evidence: directionConflict
            ? `Subject overlap ${overlap.toFixed(2)} with opposing direction terms: ${directionConflict}.`
            : `Subject overlap ${overlap.toFixed(2)} with differing negation (${negationCount(wordsA)} vs ${negationCount(wordsB)}).`,
        });
        continue;
      }

      // Signal 3: same subject, incompatible magnitudes in the same unit.
      const quantitiesA = extractQuantities(a.statement);
      const quantitiesB = extractQuantities(b.statement);
      for (const qa of quantitiesA) {
        const match = quantitiesB.find((qb) => qb.unit === qa.unit && qa.unit !== "");
        if (!match) continue;
        const larger = Math.max(Math.abs(qa.value), Math.abs(match.value));
        if (larger === 0) continue;
        const relativeGap = Math.abs(qa.value - match.value) / larger;
        // Opposite signs, or a gap wide enough that both cannot be describing
        // the same measurement.
        if (qa.value * match.value < 0 || relativeGap > 0.5) {
          candidates.push({
            claimIdA: a.id,
            claimIdB: b.id,
            kind: "incompatible_magnitude",
            signalStrength: round(clamp01(overlap * Math.min(1, relativeGap))),
            evidence: `Same subject reports ${qa.value}${qa.unit} and ${match.value}${match.unit} (relative gap ${(relativeGap * 100).toFixed(0)}%).`,
          });
          break;
        }
      }
    }
  }

  const deduped = new Map<string, ContradictionCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.claimIdA}|${candidate.claimIdB}`;
    const existing = deduped.get(key);
    if (!existing || candidate.signalStrength > existing.signalStrength) deduped.set(key, candidate);
  }

  return [...deduped.values()]
    .sort((x, y) => y.signalStrength - x.signalStrength)
    .slice(0, options.maxCandidates ?? 100);
}

/**
 * How much a contradiction should worry a reader.
 *
 * Two well-supported claims that conflict is the worst case: it means the
 * research state is internally inconsistent at high confidence. A conflict
 * between two weakly-supported claims is mostly noise.
 */
export function contradictionSeverity(
  claimA: Claim,
  claimB: Claim,
  signalStrength: number,
): number {
  const confidenceA = claimA.confidence?.score ?? 0.5;
  const confidenceB = claimB.confidence?.score ?? 0.5;
  // Both confident → severe. One confident and one not → the weak one is
  // probably just wrong, which is a smaller problem.
  const jointConfidence = Math.min(confidenceA, confidenceB);
  return round(clamp01(0.3 * signalStrength + 0.7 * jointConfidence));
}
