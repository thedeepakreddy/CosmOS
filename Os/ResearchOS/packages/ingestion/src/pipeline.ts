/**
 * Fetch, parse, chunk — the path from a URL to citable spans.
 *
 * The pipeline never fetches directly. It goes through the tool registry, which
 * means every ingest passes the permission policy, the domain allowlist, the
 * SSRF rules and the per-task budget. A pipeline with its own HTTP client would
 * be a second door into the network with none of those controls on it.
 *
 * Failure is a returned value, not an exception. A source that could not be
 * fetched is a recorded fact about the research — "this was unreachable" is
 * information a report should carry — so it is modelled rather than thrown.
 */
import type { SourceChunk, SourceDocument, ToolPermissionPolicy } from "@research-os/contracts";
import type { ToolContext, ToolRegistry } from "@research-os/tools";
import { contentHash, estimateTokens, newId, systemClock, type Clock } from "@research-os/shared";
import { chunkText, offsetsAreExact, type ChunkOptions } from "./chunk.ts";
import { parseByContentType, type ParsedDocument } from "./parse.ts";

export interface IngestRequest {
  readonly projectId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly policy: ToolPermissionPolicy;
  readonly taskId?: string | null;
  readonly agentRunId?: string | null;
  readonly signal?: AbortSignal;
  readonly chunkOptions?: ChunkOptions;
}

export interface IngestSuccess {
  readonly ok: true;
  readonly document: SourceDocument;
  readonly chunks: SourceChunk[];
  /** Everything recovered about where this came from. Never discarded. */
  readonly provenance: {
    readonly url: string;
    readonly finalUrl: string;
    readonly retrievedAt: string;
    readonly contentHash: string;
    readonly contentType: string | null;
    readonly truncated: boolean;
  };
  /** Metadata found in the document, for enriching the source record. */
  readonly metadata: ParsedDocument["metadata"];
}

export interface IngestFailure {
  readonly ok: false;
  readonly reason: string;
  readonly code: string;
}

export type IngestResult = IngestSuccess | IngestFailure;

export interface IngestionPipelineOptions {
  readonly tools: ToolRegistry;
  readonly clock?: Clock;
  readonly fetchToolId?: string;
  readonly chunkOptions?: ChunkOptions;
}

/** The shape `web_fetch` returns. Validated structurally rather than trusted. */
interface FetchOutput {
  url: string;
  finalUrl: string;
  content: string;
  truncated: boolean;
  provenance: { url?: string; retrievedAt: string; contentType?: string; contentHash?: string };
}

function isFetchOutput(value: unknown): value is FetchOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FetchOutput>;
  return typeof candidate.content === "string" && typeof candidate.finalUrl === "string";
}

export class IngestionPipeline {
  readonly #tools: ToolRegistry;
  readonly #clock: Clock;
  readonly #fetchToolId: string;
  readonly #chunkOptions: ChunkOptions;

  constructor(options: IngestionPipelineOptions) {
    this.#tools = options.tools;
    this.#clock = options.clock ?? systemClock;
    this.#fetchToolId = options.fetchToolId ?? "web_fetch";
    this.#chunkOptions = options.chunkOptions ?? {};
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const context: ToolContext = {
      projectId: request.projectId,
      taskId: request.taskId ?? null,
      agentRunId: request.agentRunId ?? null,
      policy: request.policy,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    const outcome = await this.#tools.call(this.#fetchToolId, { url: request.url }, context);
    if (outcome.status !== "succeeded") {
      return { ok: false, code: outcome.errorCode, reason: outcome.errorMessage };
    }
    if (!isFetchOutput(outcome.output)) {
      return { ok: false, code: "tool_error", reason: `Tool "${this.#fetchToolId}" returned an unexpected shape.` };
    }

    const fetched = outcome.output;
    const contentType = fetched.provenance.contentType ?? "text/html";
    const parsed = parseByContentType(fetched.content, contentType, request.url);

    if (parsed.text.trim().length === 0) {
      // A page that fetched cleanly but yielded no prose is a real outcome —
      // a paywall, a JavaScript shell, a redirect page. Saying so is more
      // useful than storing an empty document that looks like a valid source.
      return { ok: false, code: "unsupported", reason: `Fetched ${fetched.finalUrl} but it contained no extractable text.` };
    }

    const now = this.#clock.isoNow();
    const documentId = newId("document");

    const document: SourceDocument = {
      id: documentId,
      projectId: request.projectId,
      sourceId: request.sourceId,
      title: parsed.title,
      text: parsed.text,
      sections: parsed.sections,
      language: parsed.language,
      tokenCount: estimateTokens(parsed.text),
      createdAt: now,
    } as SourceDocument;

    const spans = chunkText(parsed.text, parsed.sections, { ...this.#chunkOptions, ...request.chunkOptions });

    // Checked on every ingest, not only in tests. An offset bug would otherwise
    // surface months later as a quote nobody can reproduce.
    if (!offsetsAreExact(parsed.text, spans)) {
      return {
        ok: false,
        code: "internal_error",
        reason: "Chunk offsets did not address their own text. Refusing to store spans a quote could not be checked against.",
      };
    }

    const chunks = spans.map((span) => ({
      id: newId("chunk"),
      projectId: request.projectId,
      sourceId: request.sourceId,
      documentId,
      position: span.position,
      text: span.text,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      locator: span.locator,
      tokenCount: span.tokenCount,
      embedding: null,
      embeddingModel: null,
      createdAt: now,
    })) as SourceChunk[];

    return {
      ok: true,
      document,
      chunks,
      provenance: {
        url: request.url,
        finalUrl: fetched.finalUrl,
        retrievedAt: fetched.provenance.retrievedAt,
        // Hashed from the normalised text rather than the raw bytes, so the
        // same article served with different markup deduplicates.
        contentHash: fetched.provenance.contentHash ?? contentHash(parsed.text),
        contentType,
        truncated: fetched.truncated,
      },
      metadata: parsed.metadata,
    };
  }
}
