import { Supervisor } from '../engine/Supervisor';
import { AgentExecutor } from '../engine/Executor';
import { runMigrations } from '../db/migrations';
import { closeDb } from '../db/connection';
import { createSqliteStores } from '../persistence/sqlite';
import { createWorkerId } from '../runtime/WorkerIdentity';
import { Stores } from '../persistence/contracts';
import { Config, loadConfig } from '../config';
import { logger } from '../logger';
import { metrics } from '../observability/metrics';

/**
 * Phase H: a standalone worker.
 *
 * A process that claims and executes work with NO HTTP server. This is what
 * makes horizontal scale a deployment choice rather than a rewrite -- and it is
 * only safe because Phase B replaced the blind `RUNNING -> READY` reset with an
 * atomic claim, a lease and a fencing token. Running several of these against
 * one database in v0.1 executed the same task twice, simultaneously.
 *
 * Scale by starting more of them; they contend safely on one database.
 */
export interface WorkerOptions {
  executor: AgentExecutor;
  config?: Config;
  stores?: Stores;
  /** How often to look for claimable work. */
  pollIntervalMs?: number;
  /** Stop after this long. Omit to run until stopped. */
  maxRuntimeMs?: number;
  workerId?: string;
}

export interface WorkerHandle {
  readonly workerId: string;
  /** Resolves when the worker has stopped. */
  readonly done: Promise<void>;
  stop(): void;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

export function startWorker(options: WorkerOptions): WorkerHandle {
  const config = options.config ?? loadConfig();
  const workerId = options.workerId ?? createWorkerId();
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  runMigrations();
  const stores = options.stores ?? createSqliteStores();
  const supervisor = new Supervisor(options.executor, {
    stores, workerId, leaseMs: config.leaseMs
  });

  let stopped = false;
  const startedAt = Date.now();
  logger.info({ workerId, pollIntervalMs, leaseMs: config.leaseMs }, 'AgentOS worker started');

  const loop = (async () => {
    while (!stopped) {
      try {
        // Adopt every unfinished run. Claims decide what this worker actually
        // gets: a task under a live lease is untouchable, and abandoned work
        // becomes claimable only once its lease expires.
        for (const run of stores.runs.listActive()) {
          if (stopped) break;
          if (TERMINAL.has(run.state)) continue;
          try {
            if (run.state === 'CREATED') await supervisor.startRun(run.id);
            else if (run.state === 'RUNNING') await supervisor.recoverRun(run.id);
          } catch {
            // Lost a race with another worker, or the run changed state
            // underneath us. Both are normal under contention.
          }
        }
        metrics.setGauge('agentos_worker_up', 1, { worker: workerId });
      } catch (err) {
        logger.error({ err, workerId }, 'worker poll failed');
      }

      if (options.maxRuntimeMs && Date.now() - startedAt > options.maxRuntimeMs) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    supervisor.close();
    logger.info({ workerId }, 'AgentOS worker stopped');
  })();

  return { workerId, done: loop, stop: () => { stopped = true; } };
}

if (require.main === module) {
  const config = loadConfig();

  // No executor by default: a real one (a provider adapter behind the Phase G
  // contracts) is supplied by the deployment. Failing loudly beats silently
  // running a placeholder.
  const executor: AgentExecutor = {
    async execute() {
      return { status: 'FAILED', error: 'No AgentExecutor configured for this worker' };
    }
  };
  logger.warn(
    'No AgentExecutor configured: this worker will claim tasks and fail them. ' +
    'Import startWorker() and pass an executor to run real work.'
  );

  const handle = startWorker({ executor, config });
  const shutdown = (signal: string) => {
    logger.info({ signal, workerId: handle.workerId }, 'shutting down worker');
    handle.stop();
    handle.done.then(() => { closeDb(); process.exit(0); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
