/**
 * Source quality scoring.
 *
 * Quality is a weighted aggregate over seven named dimensions. Two properties
 * are non-negotiable:
 *
 *   1. Every dimension value records the signal that produced it, so a score can
 *      be explained and re-derived rather than trusted.
 *   2. A model may *assess* a dimension, but it never emits the aggregate. The
 *      aggregate is arithmetic over dimensions, computed here.
 *
 * Deterministic priors come from what we know about a source's type before
 * anyone reads it (a preprint is not peer reviewed; a forum post is not primary
 * research). Model assessment and external metrics then refine individual
 * dimensions, each recorded as its own signal.
 */
import type {
  QualitySignal,
  SourceQuality,
  SourceQualityDimensions,
  SourceQualityDimensionName,
  SourceType,
} from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

/**
 * Relative importance of each dimension. Sums to 1.
 *
 * Venue and methodological transparency lead because they are the strongest
 * available proxies for whether a finding was checked by anyone before
 * publication. Standing (citations, reputation) is weighted lowest on purpose:
 * it measures attention, which correlates with but is not the same as
 * correctness, and it systematically disadvantages recent work.
 */
export const QUALITY_WEIGHTS: Readonly<Record<SourceQualityDimensionName, number>> = {
  venue: 0.2,
  methodologyTransparency: 0.18,
  primacy: 0.15,
  corroboration: 0.15,
  independence: 0.12,
  recency: 0.1,
  standing: 0.1,
};

/**
 * Prior dimension values implied by a source's type, before anything is read.
 * `corroboration` starts low everywhere because it is only earned by finding
 * other independent sources that agree — it is never assumed.
 */
const TYPE_PRIORS: Readonly<Record<SourceType, Partial<SourceQualityDimensions>>> = {
  peer_reviewed_article: { venue: 0.9, methodologyTransparency: 0.75, primacy: 0.85, independence: 0.7, standing: 0.6 },
  conference_paper: { venue: 0.75, methodologyTransparency: 0.7, primacy: 0.8, independence: 0.7, standing: 0.55 },
  preprint: { venue: 0.45, methodologyTransparency: 0.7, primacy: 0.85, independence: 0.65, standing: 0.4 },
  book: { venue: 0.7, methodologyTransparency: 0.5, primacy: 0.5, independence: 0.6, standing: 0.6 },
  technical_report: { venue: 0.55, methodologyTransparency: 0.6, primacy: 0.7, independence: 0.45, standing: 0.4 },
  standard: { venue: 0.85, methodologyTransparency: 0.7, primacy: 0.6, independence: 0.75, standing: 0.7 },
  patent: { venue: 0.6, methodologyTransparency: 0.55, primacy: 0.8, independence: 0.35, standing: 0.4 },
  documentation: { venue: 0.55, methodologyTransparency: 0.4, primacy: 0.75, independence: 0.3, standing: 0.5 },
  dataset: { venue: 0.5, methodologyTransparency: 0.55, primacy: 0.95, independence: 0.6, standing: 0.4 },
  code_repository: { venue: 0.4, methodologyTransparency: 0.6, primacy: 0.9, independence: 0.5, standing: 0.4 },
  news_article: { venue: 0.4, methodologyTransparency: 0.2, primacy: 0.35, independence: 0.5, standing: 0.45 },
  web_page: { venue: 0.25, methodologyTransparency: 0.2, primacy: 0.4, independence: 0.4, standing: 0.3 },
  blog_post: { venue: 0.2, methodologyTransparency: 0.25, primacy: 0.5, independence: 0.35, standing: 0.25 },
  forum_post: { venue: 0.1, methodologyTransparency: 0.1, primacy: 0.6, independence: 0.4, standing: 0.15 },
  social_media: { venue: 0.05, methodologyTransparency: 0.05, primacy: 0.5, independence: 0.35, standing: 0.15 },
  internal_document: { venue: 0.35, methodologyTransparency: 0.4, primacy: 0.7, independence: 0.25, standing: 0.2 },
  user_supplied: { venue: 0.3, methodologyTransparency: 0.3, primacy: 0.6, independence: 0.4, standing: 0.2 },
  unknown: { venue: 0.15, methodologyTransparency: 0.15, primacy: 0.4, independence: 0.35, standing: 0.2 },
};

const NEUTRAL: SourceQualityDimensions = {
  venue: 0.3,
  methodologyTransparency: 0.3,
  primacy: 0.5,
  corroboration: 0.1,
  recency: 0.5,
  independence: 0.4,
  standing: 0.3,
};

/** Fields whose evidence turns over fastest get the shortest half-life. */
export const RECENCY_HALF_LIFE_DAYS = {
  fast_moving: 365,
  standard: 365 * 3,
  slow_moving: 365 * 8,
} as const;
export type RecencyProfile = keyof typeof RECENCY_HALF_LIFE_DAYS;

/**
 * Exponential decay with a floor. Old work loses currency but never becomes
 * worthless — a 1960s result that still stands is not 0.0 quality, so the
 * curve bottoms out at 0.25 rather than at zero.
 */
export function recencyScore(
  publishedAt: string | null,
  now: number,
  profile: RecencyProfile = "standard",
): number {
  if (!publishedAt) return 0.4; // Unknown date is mildly penalised, not fatal.
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return 0.4;
  const ageDays = Math.max(0, (now - published) / 86_400_000);
  const halfLife = RECENCY_HALF_LIFE_DAYS[profile];
  return clamp01(0.25 + 0.75 * 2 ** (-ageDays / halfLife));
}

export interface DeterministicQualityInput {
  readonly sourceType: SourceType;
  readonly publishedAt: string | null;
  readonly hasDoi: boolean;
  readonly authorCount: number;
  readonly recencyProfile?: RecencyProfile;
  /** Number of independent sources found to corroborate this one. */
  readonly corroboratingSources?: number;
  /** External reputation metric, already normalised to [0,1], when available. */
  readonly externalStanding?: number;
}

/**
 * Dimension values derivable without reading the source. This is always the
 * starting point; model assessment refines it rather than replacing it.
 */
export function deterministicQuality(
  input: DeterministicQualityInput,
  now: number,
): { dimensions: SourceQualityDimensions; signals: QualitySignal[] } {
  const prior = TYPE_PRIORS[input.sourceType] ?? {};
  const signals: QualitySignal[] = [];

  const dimensions: SourceQualityDimensions = { ...NEUTRAL, ...prior };

  for (const [dimension, value] of Object.entries(prior) as [SourceQualityDimensionName, number][]) {
    signals.push({
      dimension,
      basis: "deterministic_rule",
      detail: `Prior for source type "${input.sourceType}"`,
      value,
    });
  }

  dimensions.recency = recencyScore(input.publishedAt, now, input.recencyProfile ?? "standard");
  signals.push({
    dimension: "recency",
    basis: "deterministic_rule",
    detail: input.publishedAt
      ? `Published ${input.publishedAt}; ${input.recencyProfile ?? "standard"} decay profile`
      : "No publication date available",
    value: dimensions.recency,
  });

  // A DOI means a registered, resolvable, versioned record. Small but real.
  if (input.hasDoi) {
    dimensions.venue = clamp01(dimensions.venue + 0.1);
    signals.push({ dimension: "venue", basis: "deterministic_rule", detail: "Has a registered DOI", value: dimensions.venue });
  }

  // Anonymous material cannot be checked for conflicts of interest.
  if (input.authorCount === 0) {
    dimensions.independence = clamp01(dimensions.independence - 0.15);
    signals.push({ dimension: "independence", basis: "deterministic_rule", detail: "No attributable authors", value: dimensions.independence });
  }

  if (input.corroboratingSources !== undefined) {
    // Saturating: the fifth independent corroboration adds far less than the first.
    dimensions.corroboration = clamp01(1 - 1 / (1 + input.corroboratingSources * 0.6));
    signals.push({
      dimension: "corroboration",
      basis: "deterministic_rule",
      detail: `${input.corroboratingSources} independent corroborating source(s)`,
      value: dimensions.corroboration,
    });
  }

  if (input.externalStanding !== undefined) {
    dimensions.standing = clamp01(input.externalStanding);
    signals.push({ dimension: "standing", basis: "external_metric", detail: "External reputation metric", value: dimensions.standing });
  }

  return { dimensions, signals };
}

/** Weighted aggregate. The only place a quality score is produced. */
export function aggregateQuality(dimensions: SourceQualityDimensions): number {
  let total = 0;
  for (const [dimension, weight] of Object.entries(QUALITY_WEIGHTS) as [SourceQualityDimensionName, number][]) {
    total += clamp01(dimensions[dimension]) * weight;
  }
  return round(clamp01(total));
}

export interface AssessedDimension {
  readonly dimension: SourceQualityDimensionName;
  readonly value: number;
  readonly detail: string;
}

/**
 * Merges model assessments over the deterministic baseline.
 *
 * Assessments are capped in how far they may move a dimension from its
 * deterministic prior. A model that has read a blog post cannot decide it was
 * peer reviewed; it can decide the methodology is unusually well described.
 */
export const MAX_ASSESSMENT_SHIFT = 0.35;

export function applyAssessments(
  base: { dimensions: SourceQualityDimensions; signals: QualitySignal[] },
  assessments: readonly AssessedDimension[],
  assessedByRunId: string | null,
  assessedAt: string,
): SourceQuality {
  const dimensions: SourceQualityDimensions = { ...base.dimensions };
  const signals: QualitySignal[] = [...base.signals];

  for (const assessment of assessments) {
    const prior = dimensions[assessment.dimension];
    const requested = clamp01(assessment.value);
    const bounded = clamp01(
      Math.min(prior + MAX_ASSESSMENT_SHIFT, Math.max(prior - MAX_ASSESSMENT_SHIFT, requested)),
    );
    dimensions[assessment.dimension] = bounded;
    signals.push({
      dimension: assessment.dimension,
      basis: "model_assessment",
      detail:
        bounded === requested
          ? assessment.detail
          : `${assessment.detail} (clamped from ${round(requested, 2)} to ${round(bounded, 2)}: assessment may move a dimension by at most ${MAX_ASSESSMENT_SHIFT})`,
      value: bounded,
    });
  }

  return {
    dimensions,
    score: aggregateQuality(dimensions),
    signals,
    assessedAt,
    assessedByRunId,
  };
}
