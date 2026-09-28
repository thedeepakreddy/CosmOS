/**
 * Research-shaped helpers over a generic memory provider.
 *
 * The provider knows about layers and scopes; this knows that a research run
 * wants to remember a plan, a lesson, a working note. Keeping the two separate
 * is what lets the provider be swapped for a shared memory service without
 * dragging research vocabulary into it.
 *
 * Note what is *not* here: failed approaches. Those live in `failure_records`
 * with their own cross-project query, and duplicating them into memory would
 * create two answers to "what have we already tried?" that could disagree.
 * `recallRelevant` reads memory; the failure log is read from its repository.
 */
import type { MemoryLayer, MemoryRecord, MemoryScope, MemorySearchHit } from "@research-os/contracts";
import { slugify } from "@research-os/shared";
import type { MemoryProvider, StoreMemoryInput } from "./provider.ts";

export interface ResearchMemoryOptions {
  readonly provider: MemoryProvider;
  readonly tenantId?: string | null;
  readonly application?: string | null;
}

export class ResearchMemory {
  readonly #provider: MemoryProvider;
  readonly #tenantId: string | null;
  readonly #application: string | null;

  constructor(options: ResearchMemoryOptions) {
    this.#provider = options.provider;
    this.#tenantId = options.tenantId ?? null;
    this.#application = options.application ?? null;
  }

  get provider(): MemoryProvider {
    return this.#provider;
  }

  #scope(projectId: string | null, visibility: MemoryScope["visibility"]): MemoryScope {
    return { tenantId: this.#tenantId, projectId, application: this.#application, visibility };
  }

  /**
   * Working memory: scoped to one run and given a short life.
   *
   * An expiry is set deliberately. Notes an agent made to itself mid-run are
   * noise to every later run, and a memory store that never forgets them
   * gradually drowns the things worth remembering.
   */
  async remember(
    projectId: string,
    layer: MemoryLayer,
    key: string,
    content: unknown,
    options: Partial<Omit<StoreMemoryInput, "layer" | "scope" | "key" | "content">> = {},
  ): Promise<MemoryRecord> {
    return this.#provider.store({
      layer,
      scope: this.#scope(projectId, layer === "working" ? "run" : "project"),
      key: normaliseKey(key),
      content,
      ...options,
    });
  }

  /**
   * A lesson worth carrying beyond this project.
   *
   * Tenant-visible, so a later project can find it. This is for transferable
   * *knowledge* — "government statistics for this region are published with a
   * two-year lag" — not for failed approaches, which have their own store.
   */
  async rememberLesson(projectId: string, key: string, lesson: string, tags: readonly string[] = []): Promise<MemoryRecord> {
    return this.#provider.store({
      layer: "project",
      scope: this.#scope(projectId, "tenant"),
      key: normaliseKey(`lesson:${key}`),
      content: { lesson, learnedInProjectId: projectId },
      searchText: lesson,
      salience: 0.7,
      tags: ["lesson", ...tags],
    });
  }

  /** Caller preferences. Never mixed with research knowledge, so they cannot become findings. */
  async rememberPreference(projectId: string | null, key: string, value: unknown): Promise<MemoryRecord> {
    return this.#provider.store({
      layer: "preference",
      scope: this.#scope(projectId, projectId ? "project" : "tenant"),
      key: normaliseKey(`preference:${key}`),
      content: value,
      salience: 0.9,
      tags: ["preference"],
    });
  }

  /**
   * What this run should know before planning.
   *
   * `preference` is excluded by default. A caller's stated preferences must not
   * be retrieved as though they were evidence about the world — that is the
   * mechanism by which "the user likes concise answers" turns into a finding.
   */
  async recallRelevant(
    projectId: string,
    text: string,
    options: { layers?: readonly MemoryLayer[]; limit?: number; includePreferences?: boolean } = {},
  ): Promise<MemorySearchHit[]> {
    const layers = options.layers ?? (["project", "evidence", "claim", "experiment"] as const);
    return this.#provider.search({
      text,
      layers: options.includePreferences ? [...layers, "preference"] : [...layers],
      scope: { projectId, tenantId: this.#tenantId },
      tags: [],
      referenceIds: [],
      limit: options.limit ?? 20,
      mode: "auto",
    });
  }

  /** Everything recorded about a specific entity. Exact lookup, not similarity. */
  async recallAbout(projectId: string, entityId: string, limit = 20): Promise<MemorySearchHit[]> {
    return this.#provider.search({
      layers: [],
      scope: { projectId },
      tags: [],
      referenceIds: [entityId],
      limit,
      mode: "exact",
    });
  }

  /** Lessons from earlier projects in the same tenant. */
  async recallLessons(text: string, limit = 10): Promise<MemorySearchHit[]> {
    return this.#provider.search({
      text,
      layers: ["project"],
      scope: { tenantId: this.#tenantId },
      tags: ["lesson"],
      referenceIds: [],
      limit,
      mode: "auto",
    });
  }

  /** Drops working memory once a run ends. */
  async clearWorking(projectId: string): Promise<number> {
    const hits = await this.#provider.search({
      layers: ["working"],
      scope: { projectId },
      tags: [],
      referenceIds: [],
      limit: 200,
      mode: "exact",
    });
    for (const hit of hits) await this.#provider.forget(hit.record.id);
    return hits.length;
  }
}

/**
 * Keys are slugified per segment.
 *
 * Keys are retrieval handles and are frequently model-generated, so without
 * normalisation the same memory gets written under "Hypothesis: Memory Helps"
 * and "hypothesis:memory-helps" and the upsert stops deduplicating.
 */
export function normaliseKey(key: string): string {
  return key
    .split(":")
    .map((segment) => slugify(segment, 120))
    .filter(Boolean)
    .join(":")
    .slice(0, 500);
}
