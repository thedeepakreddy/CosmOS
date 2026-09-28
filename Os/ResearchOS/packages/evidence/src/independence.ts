/**
 * Independence discounting.
 *
 * Seventeen citations of one press release is one piece of evidence, not
 * seventeen. Without this correction, confidence would be a measure of how
 * loudly a finding was repeated rather than how well it was established — which
 * is the single most common way automated research systems mislead.
 *
 * Correlated items are found, ranked, and then each item is discounted by how
 * much it overlaps with the stronger items already counted.
 */
import type { Evidence, EvidenceCorrelation, IndependenceRelation, Source } from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

/**
 * How much redundancy each relation implies. `same_source` is total: two quotes
 * from one document are one document's worth of evidence.
 */
export const RELATION_CORRELATION: Readonly<Record<IndependenceRelation, number>> = {
  same_source: 1.0,
  derived_from: 0.9,
  same_dataset: 0.8,
  same_authors: 0.7,
  same_publisher: 0.6,
};

export interface EvidenceWithSource {
  readonly evidence: Evidence;
  readonly source: Source;
  /** Raw weight before independence discounting. */
  readonly weight: number;
}

function sharedAuthors(a: Source, b: Source): boolean {
  if (a.authors.length === 0 || b.authors.length === 0) return false;
  const normalise = (name: string) => name.trim().toLowerCase();
  const setA = new Set(a.authors.map(normalise));
  return b.authors.some((author) => setA.has(normalise(author)));
}

function datasetOf(source: Source): string | undefined {
  const value = source.metadata["datasetId"] ?? source.metadata["dataset"];
  return typeof value === "string" ? value : undefined;
}

function derivedFrom(source: Source): string | undefined {
  const value = source.metadata["derivedFromSourceId"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Strongest correlation between two evidence items, with the relation that
 * produced it. Returns undefined when they are independent as far as we can
 * tell — which is an assumption, and is why the relation is recorded.
 */
export function correlationBetween(
  a: EvidenceWithSource,
  b: EvidenceWithSource,
): { relation: IndependenceRelation; correlation: number; detail: string } | undefined {
  if (a.evidence.sourceId === b.evidence.sourceId) {
    return { relation: "same_source", correlation: RELATION_CORRELATION.same_source, detail: `Both quote source ${a.source.id}` };
  }
  if (derivedFrom(a.source) === b.source.id || derivedFrom(b.source) === a.source.id) {
    return { relation: "derived_from", correlation: RELATION_CORRELATION.derived_from, detail: "One source is derived from the other" };
  }
  const datasetA = datasetOf(a.source);
  if (datasetA && datasetA === datasetOf(b.source)) {
    return { relation: "same_dataset", correlation: RELATION_CORRELATION.same_dataset, detail: `Both analyse dataset ${datasetA}` };
  }
  if (sharedAuthors(a.source, b.source)) {
    return { relation: "same_authors", correlation: RELATION_CORRELATION.same_authors, detail: "Overlapping authorship" };
  }
  if (a.source.domain && a.source.domain === b.source.domain) {
    return { relation: "same_publisher", correlation: RELATION_CORRELATION.same_publisher, detail: `Both published on ${a.source.domain}` };
  }
  return undefined;
}

export interface IndependenceResult {
  /** Multiplier in [0,1] per evidence id: 1 = counted in full, 0 = fully redundant. */
  readonly weights: ReadonlyMap<string, number>;
  readonly correlations: readonly EvidenceCorrelation[];
  /** Sum of (weight × independenceWeight): the count that actually matters. */
  readonly effectiveCount: number;
  readonly distinctSources: number;
  readonly distinctDomains: number;
}

/**
 * Greedy discounting: strongest evidence first, each later item reduced by its
 * overlap with everything already counted.
 *
 * Greedy rather than optimal is the right trade here — it is deterministic,
 * O(n²) on a set that is never large, and it keeps the single best item at full
 * weight, which is the behaviour a reader expects when they ask why a number
 * came out where it did.
 */
export function computeIndependence(items: readonly EvidenceWithSource[]): IndependenceResult {
  const ordered = [...items].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.evidence.id < b.evidence.id ? -1 : 1; // Stable: IDs are unique.
  });

  const weights = new Map<string, number>();
  const correlations: EvidenceCorrelation[] = [];
  const accepted: EvidenceWithSource[] = [];

  for (const item of ordered) {
    let independence = 1;
    for (const prior of accepted) {
      const link = correlationBetween(item, prior);
      if (!link) continue;
      correlations.push({
        evidenceIdA: item.evidence.id,
        evidenceIdB: prior.evidence.id,
        relation: link.relation,
        correlation: link.correlation,
        detail: link.detail,
      });
      independence *= 1 - link.correlation;
    }
    weights.set(item.evidence.id, round(clamp01(independence)));
    accepted.push(item);
  }

  let effectiveCount = 0;
  for (const item of ordered) {
    effectiveCount += item.weight * (weights.get(item.evidence.id) ?? 0);
  }

  return {
    weights,
    correlations,
    effectiveCount: round(effectiveCount),
    distinctSources: new Set(items.map((item) => item.evidence.sourceId)).size,
    distinctDomains: new Set(items.map((item) => item.source.domain).filter(Boolean)).size,
  };
}
