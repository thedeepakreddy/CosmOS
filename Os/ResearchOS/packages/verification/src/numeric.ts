/**
 * Do the numbers hold up?
 *
 * Two checks, both mechanical and both catching a failure mode models are
 * genuinely prone to: restating a figure slightly wrong, and performing
 * arithmetic that does not check out. Neither requires judgement, which is
 * exactly why they can be trusted — a narrow check that is always right is worth
 * more than a broad one that is usually right.
 */

/** A number found in text, with the span it occupied. */
export interface ExtractedNumber {
  readonly value: number;
  readonly text: string;
  readonly index: number;
  /** Percent, currency or a bare quantity — a figure's unit changes its meaning. */
  readonly unit: "percent" | "currency" | "none";
}

const NUMBER_PATTERN = /([$£€]\s*)?(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent)?/gi;

export function extractNumbers(text: string): ExtractedNumber[] {
  const found: ExtractedNumber[] = [];
  NUMBER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = NUMBER_PATTERN.exec(text)) !== null) {
    const raw = match[2];
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    found.push({
      value,
      text: match[0].trim(),
      index: match.index,
      unit: match[3] ? "percent" : match[1] ? "currency" : "none",
    });
  }
  return found;
}

export interface NumericConsistencyResult {
  readonly outcome: "passed" | "failed" | "not_applicable";
  readonly detail: string;
  /** Figures in the claim that appear nowhere in its evidence. */
  readonly unsupported: ExtractedNumber[];
}

/**
 * Every figure a claim states must appear in the evidence it cites.
 *
 * A claim asserting "18%" whose evidence only ever says "8%" is a
 * transcription error that changes the finding, and no amount of prose review
 * reliably catches it.
 *
 * Tolerance is relative, so a claim rounding 18.3 to 18 passes while one turning
 * 8 into 18 does not.
 */
export function checkNumericConsistency(
  claimText: string,
  evidenceTexts: readonly string[],
  options: { relativeTolerance?: number } = {},
): NumericConsistencyResult {
  const tolerance = options.relativeTolerance ?? 0.02;
  const claimNumbers = extractNumbers(claimText);

  if (claimNumbers.length === 0) {
    return { outcome: "not_applicable", detail: "The claim states no figures.", unsupported: [] };
  }

  const evidenceNumbers = evidenceTexts.flatMap((text) => extractNumbers(text));
  if (evidenceNumbers.length === 0) {
    return {
      outcome: "failed",
      detail: `The claim states ${claimNumbers.length} figure(s), but its evidence contains none.`,
      unsupported: claimNumbers,
    };
  }

  const unsupported = claimNumbers.filter((number) =>
    !evidenceNumbers.some((candidate) => {
      // A percentage and a bare quantity that happen to share a digit are not
      // the same figure, so units must agree before values are compared.
      if (candidate.unit !== number.unit) return false;
      const allowed = Math.max(Math.abs(number.value) * tolerance, 1e-9);
      return Math.abs(candidate.value - number.value) <= allowed;
    }),
  );

  return unsupported.length === 0
    ? {
        outcome: "passed",
        detail: `All ${claimNumbers.length} figure(s) in the claim appear in its evidence.`,
        unsupported: [],
      }
    : {
        outcome: "failed",
        detail: `Figure(s) not found in the cited evidence: ${unsupported.map((number) => number.text).join(", ")}.`,
        unsupported,
      };
}

export interface ArithmeticStatement {
  readonly expression: string;
  readonly stated: number;
  readonly computed: number;
  readonly correct: boolean;
}

const ARITHMETIC = /(-?\d[\d,]*(?:\.\d+)?)\s*([+\-*/x×÷])\s*(-?\d[\d,]*(?:\.\d+)?)\s*(?:=|equals|is)\s*(-?\d[\d,]*(?:\.\d+)?)/gi;
const PERCENTAGE_OF = /(-?\d[\d,]*(?:\.\d+)?)\s*(?:%|percent|per cent)\s+of\s+(-?\d[\d,]*(?:\.\d+)?)\s*(?:=|is|equals)\s*(-?\d[\d,]*(?:\.\d+)?)/gi;

const toNumber = (raw: string): number => Number(raw.replace(/,/g, ""));

/**
 * Finds and checks arithmetic stated in prose.
 *
 * Deliberately limited to forms that are unambiguous in text. A parser that
 * tried to evaluate arbitrary expressions would start guessing at precedence
 * and produce false failures, and a verification check that cries wolf gets
 * ignored — which is worse than not having it.
 */
export function checkArithmetic(text: string, options: { relativeTolerance?: number } = {}): ArithmeticStatement[] {
  const tolerance = options.relativeTolerance ?? 0.01;
  const statements: ArithmeticStatement[] = [];

  const record = (expression: string, stated: number, computed: number): void => {
    if (!Number.isFinite(computed)) return;
    const allowed = Math.max(Math.abs(computed) * tolerance, 1e-9);
    statements.push({ expression, stated, computed, correct: Math.abs(stated - computed) <= allowed });
  };

  PERCENTAGE_OF.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PERCENTAGE_OF.exec(text)) !== null) {
    const [whole, percent, base, stated] = match;
    if (!percent || !base || !stated) continue;
    record(whole.trim(), toNumber(stated), (toNumber(percent) / 100) * toNumber(base));
  }

  ARITHMETIC.lastIndex = 0;
  while ((match = ARITHMETIC.exec(text)) !== null) {
    const [whole, left, operator, right, stated] = match;
    if (!left || !operator || !right || !stated) continue;
    const a = toNumber(left);
    const b = toNumber(right);
    const computed =
      operator === "+" ? a + b
        : operator === "-" ? a - b
          : operator === "*" || operator === "x" || operator === "×" ? a * b
            : b === 0 ? Number.NaN : a / b;
    record(whole.trim(), toNumber(stated), computed);
  }

  return statements;
}
