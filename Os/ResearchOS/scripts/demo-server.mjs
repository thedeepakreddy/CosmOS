/**
 * The demo API: the real server, plus one tool the platform does not ship.
 *
 * ResearchOS has no search engine, so `source.discover` reports BLOCKED. That is
 * correct — but a plan hangs its extraction, claim and report steps off
 * discovery, and a task may only be claimed once every dependency is
 * `completed`. A blocked discovery is `failed`, so the whole chain behind it
 * becomes permanently unclaimable and the run stalls in `running` with no
 * report. Supplying source URLs through `POST /evidence` does not help: those
 * create standalone ingest tasks that sit outside the plan graph, so the
 * corpus arrives but nothing is wired to consume it.
 *
 * This wires a tool that answers discovery with *the corpus the caller already
 * supplied*. Discovery then succeeds, its dependents unblock, and the run
 * proceeds over the user's own sources.
 *
 * It is not a search engine and must never be mistaken for one — see the
 * descriptor below. `extraTools` is the documented seam for exactly this, and
 * using it means no package in the certified core changes.
 */
import { z } from "zod";
import { ToolDescriptor } from "@research-os/contracts";
import { loadConfig } from "../apps/api/dist/config.js";
import { buildContext } from "../apps/api/dist/app-context.js";
import { createServer } from "../apps/api/dist/server.js";

const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().default(10),
});

/**
 * Returns the URLs the caller supplied for this project, and nothing else.
 *
 * Two places are read, because there are two supported ways to supply a corpus
 * and a demo should work with either:
 *
 *   - `project.metadata.sourceUrls`, written at creation;
 *   - the `url` on any `source.ingest` task, which is what `POST /evidence`
 *     creates.
 *
 * The query is recorded but deliberately not used to filter. Pretending to rank
 * a caller-supplied list against a model-written query would invent a relevance
 * signal that does not exist, and every downstream confidence number would
 * inherit it.
 */
class SuppliedCorpusTool {
  inputSchema = SearchInput;
  /** Bound after the runtime is built, because the store is built with it. */
  store = null;
  queries = [];

  constructor() {
    this.descriptor = ToolDescriptor.parse({
      id: "supplied_corpus",
      name: "Supplied corpus",
      description:
        "Returns the source URLs the caller supplied for this project. This is NOT a web search: " +
        "it discovers nothing, reaches no search engine, and can only surface what was already provided. " +
        "A run using it has searched nowhere.",
      capability: "web_search",
      riskLevel: "read_only",
      inputSchema: z.toJSONSchema(SearchInput),
      provider: "local",
    });
  }

  async execute(input, context) {
    this.queries.push(input.query);
    if (!this.store) return { results: [] };

    const found = new Map();

    const project = await this.store.projects.findById(context.projectId);
    for (const url of project?.metadata?.sourceUrls ?? []) {
      if (typeof url === "string" && url) found.set(url, url);
    }

    const tasks = await this.store.tasks.list(context.projectId, { limit: 200 });
    for (const task of tasks) {
      if (task.type !== "source.ingest") continue;
      const url = task.input?.url;
      if (typeof url === "string" && url) found.set(url, url);
    }

    // Anything already ingested carries a real title; prefer it over the URL.
    for (const source of await this.store.research.listSources(context.projectId, { limit: 200 })) {
      if (source.url) found.set(source.url, source.title || source.url);
    }

    const results = [...found.entries()]
      .slice(0, input.limit)
      .map(([url, title]) => ({ url, title }));

    context.logger?.info("Supplied corpus returned", { query: input.query, results: results.length });
    return { results };
  }
}

async function main() {
  const config = loadConfig();
  const corpus = new SuppliedCorpusTool();

  const context = await buildContext(config, { extraTools: [corpus] });
  // The store exists only once the runtime is built, so the tool is bound now.
  corpus.store = context.store;

  const app = await createServer(context);

  const worker = config.embeddedWorker ? context.engine.createWorker({ workerId: `demo-${process.pid}` }) : null;
  const workerLoop = worker ? worker.run() : Promise.resolve();

  await app.listen({ host: config.host, port: config.port });
  context.logger.info("ResearchOS demo API listening", {
    address: `http://${config.host}:${config.port}`,
    database: config.databaseDescription,
    gaps: context.gaps.length,
    suppliedCorpusTool: true,
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    context.logger.info("Shutting down", { signal });
    worker?.stop();
    await app.close();
    await workerLoop;
    await context.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
