/**
 * Worker entry point.
 *
 * The same engine as the API, without the HTTP surface. Several of these can run
 * against one database: leases make that safe, and `FOR UPDATE SKIP LOCKED`
 * means they do not contend for the same row.
 *
 * This process serves no traffic, so it needs no authentication and opens no
 * port. It only takes work off the queue.
 */
import { buildRuntime, loadRuntimeConfig } from "@research-os/research-core";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const context = await buildRuntime(config);

  const worker = context.engine.createWorker({
    workerId: `worker-${process.pid}`,
    batchSize: 4,
  });

  context.logger.info("ResearchOS worker started", {
    workerId: worker.workerId,
    database: config.databaseDescription,
    handlers: context.engine.supportedTaskTypes().length,
    gaps: context.gaps,
  });

  const loop = worker.run();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    context.logger.info("Shutting down; finishing the current tick", { signal });
    worker.stop();
    await loop;
    await context.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await loop;
}

await main();
