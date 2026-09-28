/**
 * Fixture builders for confidence tests.
 *
 * Deliberately explicit: every test states the exact evidence configuration it
 * is asserting on, so a scoring change that breaks an expectation shows which
 * property changed rather than just which number moved.
 */
import type { Evidence, Source, SourceQuality } from "@research-os/contracts";

let counter = 0;
const pad = (n: number) => n.toString(36).toUpperCase().padStart(26, "0");
export const nextId = (prefix: string): string => `${prefix}_${pad(++counter)}`;

export const NOW = "2026-01-15T12:00:00.000Z";

export function makeQuality(score: number): SourceQuality {
  return {
    dimensions: {
      venue: score,
      methodologyTransparency: score,
      primacy: score,
      corroboration: score,
      recency: score,
      independence: score,
      standing: score,
    },
    score,
    signals: [],
    assessedAt: NOW,
    assessedByRunId: null,
  };
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: nextId("src") as Source["id"],
    projectId: "prj_TEST" as Source["projectId"],
    url: "https://example.org/a",
    doi: null,
    title: "A source",
    authors: [],
    publisher: null,
    publishedAt: "2025-06-01T00:00:00.000Z",
    sourceType: "peer_reviewed_article",
    status: "indexed",
    domain: "example.org",
    contentHash: null,
    storageKey: null,
    retrievedAt: NOW,
    quality: makeQuality(0.8),
    discoveredBy: null,
    failureReason: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Source;
}

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: nextId("evd") as Evidence["id"],
    projectId: "prj_TEST" as Evidence["projectId"],
    sourceId: nextId("src") as Evidence["sourceId"],
    chunkIds: [],
    quote: "Persistent memory improved task completion by 18%.",
    locator: "§4.2",
    interpretation: "Supports the hypothesis.",
    stance: "supports",
    strength: {
      directness: 0.9,
      specificity: 0.85,
      methodologicalRigor: 0.8,
      quoteFidelity: 1,
    },
    relevance: 0.9,
    extractedByRunId: null,
    verifiedAt: null,
    verificationPassed: null,
    createdAt: NOW,
    ...overrides,
  } as Evidence;
}

/** A matched evidence+source pair, wired so the evidence points at its source. */
export function pair(
  evidenceOverrides: Partial<Evidence> = {},
  sourceOverrides: Partial<Source> = {},
): { evidence: Evidence; source: Source } {
  const source = makeSource(sourceOverrides);
  const evidence = makeEvidence({ ...evidenceOverrides, sourceId: source.id });
  return { evidence, source };
}

/**
 * N mutually independent items of identical quality — distinct domains, distinct
 * authors, so the independence discount leaves each at full weight.
 *
 * `ns` namespaces the generated domains and authors. Without it, two calls in
 * one test (say a supporting set and a contradicting set) would generate the
 * same `site-0.org` / `Author 0` values and be correctly — but unintentionally —
 * discounted as correlated, which silently weakens the test.
 */
export function independentSupport(
  count: number,
  options: { quality?: number; stance?: Evidence["stance"]; ns?: string } = {},
): { evidence: Evidence; source: Source }[] {
  const ns = options.ns ?? options.stance ?? "supports";
  return Array.from({ length: count }, (_, index) =>
    pair(
      { stance: options.stance ?? "supports" },
      {
        domain: `${ns}-${index}.org`,
        url: `https://${ns}-${index}.org/paper`,
        authors: [`${ns} Author ${index}`],
        quality: makeQuality(options.quality ?? 0.8),
      },
    ),
  );
}
