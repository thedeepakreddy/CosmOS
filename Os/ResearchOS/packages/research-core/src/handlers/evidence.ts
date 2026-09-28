/**
 * Source ingestion and evidence extraction.
 *
 * The chain this implements is the one everything else depends on:
 *
 *   URL → fetched document → chunks → retrieved passages → evidence → claim
 *
 * Each arrow preserves provenance. A chunk knows its offsets in the document, an
 * evidence item knows the chunks it came from, and a claim knows its evidence.
 * Any link dropped here cannot be recovered later, which is why ingestion stores
 * the content hash and retrieval time on the source row rather than discarding
 * them once the text is extracted.
 */
import { Evidence, Source, type TaskOutcome, type ToolCapability, type ToolPermissionPolicy } from "@research-os/contracts";
import { ToolPermissionPolicy as ToolPermissionPolicySchema } from "@research-os/contracts";
import { aggregateQuality, deterministicQuality } from "@research-os/evidence";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { contentHash, domainOf, newId } from "@research-os/shared";
import { runAgent } from "../agent.ts";
import { evidenceAgent } from "../agents/evidence-agent.ts";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, blocked, completed, emit } from "./support.ts";

export interface PolicyOptions {
  /** Tool ids this step needs, beyond the fetching default. */
  readonly toolIds?: readonly string[];
  readonly capabilities?: readonly ToolCapability[];
}

/**
 * Derives the tool policy for one step from the caller's preferences.
 *
 * Empty `allowedTools` means "the research defaults" — fetching, plus whatever
 * the step itself asks for. It never means "everything": the registry is
 * default-deny, and a tool nobody named stays unavailable.
 *
 * A caller that *did* restrict `allowedTools` is honoured exactly. A step asking
 * for a tool the caller excluded gets a policy that does not permit it, and the
 * step reports itself blocked — which is the correct outcome, because the
 * caller decided that.
 */
export function policyFor(
  preferences: {
    allowedTools: readonly string[];
    blockedDomains: readonly string[];
    preferredDomains: readonly string[];
  },
  options: PolicyOptions = {},
): ToolPermissionPolicy {
  const requested = [...new Set(["web_fetch", ...(options.toolIds ?? [])])];
  const allowedToolIds = preferences.allowedTools.length > 0
    ? requested.filter((id) => preferences.allowedTools.includes(id))
    : requested;

  return ToolPermissionPolicySchema.parse({
    allowedToolIds,
    allowedCapabilities: [...new Set(["web_fetch", "http_request", ...(options.capabilities ?? [])])],
    maxRiskLevel: "read_only",
    allowedDomains: [...preferences.preferredDomains],
    blockedDomains: [...preferences.blockedDomains],
    maxCallsPerTask: 25,
  });
}

export function sourceIngestHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "source.ingest",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      if (!deps.ingestion) {
        return blocked("source ingestion", "no ingestion pipeline is configured, so sources cannot be fetched or parsed");
      }

      const input = (task.task.input ?? {}) as { sourceId?: string; url?: string };
      if (!input.url) {
        return { kind: "failed", errorCode: "validation_failed", errorMessage: "source.ingest requires a url.", retryable: false };
      }

      const context = await agentContextFor(deps, task);
      const now = deps.clock.isoNow();
      const sourceId = input.sourceId ?? newId("source");

      const result = await deps.ingestion.ingest({
        projectId: task.projectId,
        sourceId,
        url: input.url,
        policy: policyFor(context.preferences),
        taskId: task.task.id,
      });

      if (!result.ok) {
        // A source that could not be fetched is recorded as a source with a
        // failure reason, not dropped. "We tried this and could not read it" is
        // information the report should carry.
        await deps.store.research.upsertSource(
          Source.parse({
            id: sourceId,
            projectId: task.projectId,
            url: input.url,
            doi: null,
            title: input.url.slice(0, 200),
            authors: [],
            publisher: null,
            publishedAt: null,
            sourceType: "web_page",
            status: "failed",
            domain: domainOf(input.url) ?? null,
            contentHash: null,
            storageKey: null,
            retrievedAt: null,
            quality: null,
            discoveredBy: "source.ingest",
            failureReason: result.reason,
            createdAt: now,
            updatedAt: now,
          }),
        );
        await emit(deps, task.projectId, "research.source.failed", { sourceId, reason: result.reason });
        return { kind: "failed", errorCode: result.code, errorMessage: result.reason, retryable: result.code === "timeout" };
      }

      const quality = deterministicQuality(
        {
          sourceType: "web_page",
          publishedAt: result.metadata.publishedAt,
          hasDoi: Boolean(result.metadata.doi),
          authorCount: result.metadata.authors.length,
        },
        Date.parse(now),
      );

      const source = Source.parse({
        id: sourceId,
        projectId: task.projectId,
        url: result.provenance.finalUrl,
        doi: result.metadata.doi,
        title: result.document.title,
        authors: result.metadata.authors,
        publisher: null,
        publishedAt: result.metadata.publishedAt,
        sourceType: "web_page",
        status: "parsed",
        domain: domainOf(result.provenance.finalUrl) ?? null,
        contentHash: result.provenance.contentHash,
        storageKey: null,
        retrievedAt: result.provenance.retrievedAt,
        quality: {
          dimensions: quality.dimensions,
          score: aggregateQuality(quality.dimensions),
          signals: quality.signals,
          assessedAt: now,
          assessedByRunId: null,
        },
        discoveredBy: "source.ingest",
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });

      const { created } = await deps.store.research.upsertSource(source);
      if (created) {
        await deps.store.research.saveDocument(result.document, result.chunks);
      }
      deps.retriever?.invalidate(task.projectId);

      await emit(deps, task.projectId, "research.source.processed", {
        sourceId: source.id,
        chunkCount: created ? result.chunks.length : 0,
        qualityScore: source.quality?.score ?? null,
      });

      return completed({
        sourceId: source.id,
        title: source.title,
        chunks: created ? result.chunks.length : 0,
        duplicate: !created,
        truncated: result.provenance.truncated,
      });
    },
  };
}

export function evidenceExtractHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "evidence.extract",
    leaseMs: 180_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      if (!deps.retriever) {
        return blocked("evidence extraction", "no retriever is configured, so passages cannot be found");
      }

      const context = await agentContextFor(deps, task);
      const input = (task.task.input ?? {}) as { questionIds?: string[]; question?: string; limit?: number };

      const questions = await deps.store.projects.listQuestions(task.projectId);
      const targets = input.question
        ? [{ id: null as string | null, text: input.question }]
        : questions
            .filter((question) => !input.questionIds?.length || input.questionIds.includes(question.id))
            .map((question) => ({ id: question.id as string | null, text: question.text }));

      if (targets.length === 0) {
        return completed({ extracted: 0, note: "No question was available to extract evidence for." });
      }

      const stored: Evidence[] = [];
      const runIds: string[] = [];

      for (const target of targets) {
        const retrieved = await deps.retriever.retrieve({
          projectId: task.projectId,
          query: target.text,
          limit: input.limit ?? 8,
        });
        if (retrieved.hits.length === 0) continue;

        const sourceIds = [...new Set(retrieved.hits.map((hit) => hit.chunk.sourceId as string))];
        const sources = await deps.store.research.findSourcesByIds(sourceIds);

        const result = await runAgent(
          evidenceAgent,
          {
            question: target.text,
            passages: retrieved.hits.map((hit) => ({
              text: hit.chunk.text,
              sourceTitle: sources.get(hit.chunk.sourceId as string)?.title ?? "Unknown source",
              locator: hit.chunk.locator,
            })),
          },
          context,
        );
        runIds.push(result.runId);

        for (const item of result.output.items) {
          const hit = retrieved.hits[item.passageIndex - 1];
          // An index outside the passages we supplied means the model invented
          // a reference. Dropping it is the only safe option: there is no
          // passage to check the quote against.
          if (!hit) {
            task.logger.warn("Evidence cited a passage that was not supplied", {
              passageIndex: item.passageIndex,
              supplied: retrieved.hits.length,
            });
            continue;
          }

          stored.push(
            Evidence.parse({
              id: newId("evidence"),
              projectId: task.projectId,
              sourceId: hit.chunk.sourceId,
              chunkIds: [hit.chunk.id],
              quote: item.quote,
              locator: hit.chunk.locator,
              interpretation: item.interpretation,
              stance: item.stance,
              strength: item.strength,
              relevance: item.relevance,
              extractedByRunId: result.runId,
              verifiedAt: null,
              verificationPassed: null,
              createdAt: deps.clock.isoNow(),
            }),
          );
        }
      }

      if (stored.length > 0) await deps.store.research.addEvidence(stored);
      for (const item of stored) {
        await emit(deps, task.projectId, "research.evidence.extracted", {
          evidenceId: item.id, sourceId: item.sourceId, stance: item.stance, relevance: item.relevance,
        });
      }

      return completed({
        extracted: stored.length,
        evidenceIds: stored.map((item) => item.id),
        contentHash: contentHash(stored.map((item) => item.quote).join("\n")),
      });
    },
  };
}
