/**
 * API entry point.
 *
 * Starts the HTTP server and, unless configured otherwise, a worker in the same
 * process. One process is the right default for a small deployment; splitting
 * them is a matter of running `apps/worker` separately and setting
 * `RESEARCH_OS_EMBEDDED_WORKER=false`. Nothing in the code changes, because the
 * queue is in the database rather than in memory.
 *
 * Shutdown is graceful: the worker is asked to finish its current tick and the
 * server stops accepting connections, so a task in flight is completed rather
 * than abandoned to its lease.
 */
import { loadConfig } from "./config.ts";
import { buildContext } from "./app-context.ts";
import { createServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const context = await buildContext(config);
  const app = await createServer(context);

  const worker = config.embeddedWorker ? context.engine.createWorker({ workerId: `api-${process.pid}` }) : null;
  const workerLoop = worker ? worker.run() : Promise.resolve();

  await app.listen({ host: config.host, port: config.port });
  context.logger.info("ResearchOS API listening", {
    address: `http://${config.host}:${config.port}`,
    database: config.databaseDescription,
    embeddedWorker: config.embeddedWorker,
    gaps: context.gaps.length,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
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
