/**
 * Source discovery.
 *
 * ResearchOS does not ship a web search engine, and it does not pretend to. If
 * no tool advertising `web_search` or `academic_search` is registered, this
 * handler reports the task blocked with a reason a report can print — because a
 * research run that could not look anything up should say so rather than produce
 * findings from the model's own recollection.
 *
 * Where a search tool *is* registered — through ToolOS, an external executor, or
 * a locally implemented one — discovery runs through the tool registry and
 * therefore inherits the permission policy and the call budget.
 */
import type { TaskOutcome } from "@research-os/contracts";
import type { TaskContext, TaskHandler } from "@research-os/orchestration";
import { Task } from "@research-os/contracts";
import { newId } from "@research-os/shared";
import type { ResearchDeps } from "../deps.ts";
import { agentContextFor, blocked, completed, emit } from "./support.ts";
import { policyFor } from "./evidence.ts";

const SEARCH_CAPABILITIES = new Set(["web_search", "academic_search"]);

interface SearchResultShape {
  readonly results?: readonly { url?: string; title?: string }[];
}

export function sourceDiscoverHandler(deps: ResearchDeps): TaskHandler {
  return {
    type: "source.discover",
    leaseMs: 120_000,

    async handle(task: TaskContext): Promise<TaskOutcome> {
      const context = await agentContextFor(deps, task);
      const input = (task.task.input ?? {}) as { searchQueries?: string[]; urls?: string[] };
      const now = deps.clock.isoNow();

      // A plan may name URLs directly. That path needs no search tool at all,
      // and is how a caller supplies its own corpus.
      const directUrls = input.urls ?? [];
      if (directUrls.length > 0) {
        return completed(
          { discovered: directUrls.length, via: "supplied" },
          directUrls.map((url) => ingestTask(task.projectId, url, now)),
        );
      }

      // What is registered that can search, narrowed to what the caller allows.
      const searchCapable = (deps.tools?.listAll() ?? []).filter((descriptor) => SEARCH_CAPABILITIES.has(descriptor.capability));
      const searchTool = context.preferences.allowedTools.length > 0
        ? searchCapable.find((descriptor) => context.preferences.allowedTools.includes(descriptor.id))
        : searchCapable[0];

      if (!deps.tools || !searchTool) {
        return blocked(
          "source discovery",
          "no tool providing web_search or academic_search is registered. Attach an executor that provides one, " +
            "or supply source URLs directly in the task input. Research will not answer from model recollection.",
        );
      }

      const queries = input.searchQueries?.length ? input.searchQueries : [];
      if (queries.length === 0) {
        return completed({ discovered: 0, note: "No search queries were planned for this step." });
      }

      const policy = policyFor(context.preferences, {
        toolIds: [searchTool.id],
        capabilities: [searchTool.capability],
      });

      const found = new Map<string, string>();
      for (const query of queries) {
        const outcome = await deps.tools.call(
          searchTool.id,
          { query, limit: 10 },
          { projectId: task.projectId, taskId: task.task.id, policy },
        );
        if (outcome.status !== "succeeded") {
          task.logger.warn("Search failed", { query, status: outcome.status });
          continue;
        }
        for (const result of (outcome.output as SearchResultShape).results ?? []) {
          if (result.url) found.set(result.url, result.title ?? result.url);
        }
      }

      const followUps = [...found.entries()].map(([url, title]) => ({ url, title, task: ingestTask(task.projectId, url, now) }));
      for (const followUp of followUps) {
        await emit(deps, task.projectId, "research.source.discovered", {
          sourceId: (followUp.task.input as { sourceId: string }).sourceId,
          title: followUp.title,
          url: followUp.url,
          sourceType: "web_page",
        });
      }

      return completed(
        { discovered: found.size, via: searchTool.id, queries },
        followUps.map((followUp) => followUp.task),
      );
    },
  };
}

function ingestTask(projectId: string, url: string, now: string): Task {
  return Task.parse({
    id: newId("task"),
    projectId,
    type: "source.ingest",
    status: "pending",
    priority: 60,
    dependsOn: [],
    input: { url, sourceId: newId("source") },
    output: null,
    leasedBy: null,
    leaseExpiresAt: null,
    runAfter: now,
    awaitingRequestId: null,
    errorCode: null,
    errorMessage: null,
    traceId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  });
}
