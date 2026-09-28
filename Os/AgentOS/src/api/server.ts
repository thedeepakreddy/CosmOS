import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import { runMigrations } from '../db/migrations';
import { buildRoutes } from './routes';
import { Supervisor } from '../engine/Supervisor';
import { AgentExecutor } from '../engine/Executor';
import { createSqliteStores } from '../persistence/sqlite';
import { logger, loggerOptions } from '../logger';
import { Config, loadConfig } from '../config';
import { rateLimited, unauthorized } from './errors';
import { FixedWindowRateLimiter } from './rateLimit';
import { metrics } from '../observability/metrics';

export interface BuildServerOptions {
  executor?: AgentExecutor;
  config?: Config;
}

/** Constant-time comparison, so a token cannot be recovered by timing. */
function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Endpoints reachable without credentials. */
const PUBLIC_PATHS = new Set(['/health', '/metrics']);
const PUBLIC_PREFIXES = ['/docs'];

function isPublic(url: string): boolean {
  const path = url.split('?')[0];
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export async function buildServer(
  executorOrOptions?: AgentExecutor | BuildServerOptions,
  maybeConfig?: Config
): Promise<FastifyInstance> {
  // Back-compatible signature: buildServer(executor) still works.
  const options: BuildServerOptions =
    executorOrOptions && 'execute' in (executorOrOptions as AgentExecutor)
      ? { executor: executorOrOptions as AgentExecutor, config: maybeConfig }
      : ((executorOrOptions as BuildServerOptions) ?? {});

  const config = options.config ?? loadConfig();
  const executor = options.executor;

  const fastify = Fastify({
    logger: loggerOptions,
    // Phase E: an explicit, configurable cap. Previously this was only Fastify's
    // incidental 1MB default, which the audit noted was not a deliberate control.
    bodyLimit: config.maxBodyBytes,
    ajv: {
      customOptions: {
        // Phase E: the audit found `{"id": 1}` silently coerced to `"1"` and
        // `"no"` to `["no"]`. The attached JSON Schema is for OpenAPI docs;
        // zod does the real validation in the handlers.
        coerceTypes: false,
        removeAdditional: false
      }
    }
  });

  await fastify.register(cors);
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'AgentOS API',
        description: 'Reusable agent orchestration, lifecycle, and coordination platform',
        version: '0.2.0'
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }
      }
    }
  });
  await fastify.register(swaggerUi, { routePrefix: '/docs' });

  runMigrations();

  // ---- rate limiting -------------------------------------------------------
  // Phase H: the window lives in the database, so the ceiling is SHARED across
  // workers. Phase E's limiter was explicitly per-process, which meant the
  // effective limit behind N workers was N x limit.
  const stores = createSqliteStores();
  const limiter = config.sharedRateLimit
    ? {
        check: (key: string) =>
          stores.rateLimits.check(key, config.rateLimitMax, config.rateLimitWindowMs, Date.now()),
        prune: () => stores.rateLimits.prune(Date.now())
      }
    : (() => {
        const local = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
        return { check: (key: string) => local.check(key), prune: () => local.prune() };
      })();
  const pruneTimer = setInterval(() => limiter.prune(), config.rateLimitWindowMs);
  pruneTimer.unref?.();
  fastify.addHook('onClose', async () => clearInterval(pruneTimer));

  // ---- auth + rate limit ---------------------------------------------------
  const authEnabled = config.authTokens.length > 0;

  // Phase F: request metrics. `routerPath` keeps cardinality bounded -- the raw
  // url would create one series per run id.
  fastify.addHook('onResponse', async (req, reply) => {
    const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? 'unmatched';
    metrics.increment('agentos_http_requests_total', {
      method: req.method, route, status: String(reply.statusCode)
    });
    metrics.observe('agentos_http_duration_ms', reply.elapsedTime, { route });
  });

  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (config.rateLimitEnabled) {
      // Key on the bearer token when present, otherwise the peer address, so one
      // noisy client cannot exhaust the budget for everyone behind a proxy.
      const auth = req.headers.authorization;
      const key = auth ? `t:${auth}` : `ip:${req.ip}`;
      const decision = limiter.check(key);
      reply.header('x-ratelimit-limit', String(config.rateLimitMax));
      reply.header('x-ratelimit-remaining', String(decision.remaining));
      reply.header('x-ratelimit-reset', String(decision.resetAt));
      if (!decision.allowed) {
        const err = rateLimited('Too many requests');
        reply.status(err.status);
        return reply.send(err.toBody());
      }
    }

    if (!authEnabled || isPublic(req.url)) return;

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      const err = unauthorized('Missing bearer token');
      reply.status(err.status);
      return reply.send(err.toBody());
    }
    const presented = header.slice('Bearer '.length);
    // Compare against every configured token, without early exit.
    const ok = config.authTokens.reduce(
      (acc, token) => (secureEquals(presented, token) ? true : acc),
      false
    );
    if (!ok) {
      const err = unauthorized('Invalid bearer token');
      reply.status(err.status);
      return reply.send(err.toBody());
    }
  });

  // If no executor is provided, fail safely. A real executor (Phase G) is not
  // implemented yet, so a server started without one accepts runs but every
  // task fails with an explicit reason rather than silently using a test double.
  const prodExecutor: AgentExecutor = executor || {
    async execute() {
      return { status: 'FAILED', error: 'No AgentExecutor configured in production' };
    }
  };
  if (!executor) {
    logger.warn(
      'No AgentExecutor configured: every task will fail with "No AgentExecutor configured in production". ' +
      'Pass an executor to buildServer() to run real work.'
    );
  }

  if (!authEnabled) {
    logger.warn(
      'AUTHENTICATION IS DISABLED: AGENTOS_AUTH_TOKENS is empty, so every endpoint is open to anyone ' +
      'who can reach this port. Set AGENTOS_AUTH_TOKENS, and AGENTOS_REQUIRE_AUTH=true in production.'
    );
  }

  const supervisor = new Supervisor(prodExecutor, { stores, leaseMs: config.leaseMs });

  // Phase F: bounded event retention. Only events belonging to runs that have
  // FINISHED are removed, so a live run's history is never truncated under it.
  if (config.eventRetentionMs > 0) {
    const prune = () => {
      const cutoff = new Date(Date.now() - config.eventRetentionMs).toISOString();
      const removed = stores.events.pruneBefore(cutoff);
      if (removed > 0) logger.info({ removed, cutoff }, 'pruned events for finished runs');
    };
    const pruneTimer2 = setInterval(prune, config.eventPruneIntervalMs);
    pruneTimer2.unref?.();
    fastify.addHook('onClose', async () => clearInterval(pruneTimer2));
  }
  fastify.addHook('onClose', async () => supervisor.close());

  logger.info(
    { workerId: supervisor.workerId, authEnabled, rateLimit: config.rateLimitEnabled },
    'AgentOS worker identity'
  );

  buildRoutes(fastify, supervisor, stores, config);

  fastify.get('/health', async () => ({ status: 'ok' }));

  // Phase F: Prometheus exposition. Public alongside /health so a scraper does
  // not need a credential, and it carries no run or task content -- only counts
  // and durations.
  fastify.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return metrics.render();
  });

  return fastify;
}

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    const app = await buildServer({ config });
    app.listen({ port: config.port, host: config.host }, (err, address) => {
      if (err) {
        logger.error({ err }, 'failed to start AgentOS server');
        process.exit(1);
      }
      logger.info({ address }, 'AgentOS server listening');
    });
  })().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'failed to build AgentOS server');
    process.exit(1);
  });
}
