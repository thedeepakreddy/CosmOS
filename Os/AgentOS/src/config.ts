import { z } from 'zod';

/**
 * Phase E: validated configuration.
 *
 * v0.1 read `process.env` ad hoc in two places with no validation, no defaults
 * module and no `.env.example`. A typo in a numeric variable became `NaN` and
 * silently changed behaviour. Everything configurable now passes through this
 * schema once, at startup, and a bad value fails loudly instead of degrading.
 */

const csv = (value: string): string[] =>
  value.split(',').map((s) => s.trim()).filter(Boolean);

const positiveInt = (label: string) =>
  z.coerce.number({ invalid_type_error: `${label} must be a number` })
    .int(`${label} must be an integer`)
    .positive(`${label} must be positive`);

export const ConfigSchema = z.object({
  host: z.string().min(1).default('0.0.0.0'),
  port: positiveInt('PORT').max(65535).default(3000),
  databaseUrl: z.string().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Lease duration for task claims (Phase B). */
  leaseMs: positiveInt('AGENTOS_LEASE_MS').default(30_000),

  // ---- security ------------------------------------------------------------
  /**
   * Accepted bearer tokens. When empty, authentication is DISABLED and the
   * server warns loudly at startup. Set AGENTOS_REQUIRE_AUTH=true to make an
   * unauthenticated start a hard failure instead -- the correct production
   * posture.
   */
  authTokens: z.array(z.string().min(16, 'auth tokens must be at least 16 characters')).default([]),
  requireAuth: z.boolean().default(false),

  /** Maximum accepted request body. Previously only Fastify's incidental 1MB default. */
  maxBodyBytes: positiveInt('AGENTOS_MAX_BODY_BYTES').default(1_048_576),
  /** Maximum serialized size of a single executor output. */
  maxOutputBytes: positiveInt('AGENTOS_MAX_OUTPUT_BYTES').default(262_144),
  /** Maximum tasks accepted in one run graph. */
  maxTasksPerRun: positiveInt('AGENTOS_MAX_TASKS_PER_RUN').default(10_000),

  // ---- rate limiting -------------------------------------------------------
  rateLimitEnabled: z.boolean().default(true),
  /**
   * Phase H: share the rate-limit window across workers via the database.
   * When false the limiter is per-process, so the effective ceiling behind N
   * workers is N x the limit.
   */
  sharedRateLimit: z.boolean().default(false),
  rateLimitMax: positiveInt('AGENTOS_RATE_LIMIT_MAX').default(300),
  rateLimitWindowMs: positiveInt('AGENTOS_RATE_LIMIT_WINDOW_MS').default(60_000),

  // ---- event retention -----------------------------------------------------
  /**
   * How long to keep events for FINISHED runs. The audit found the events table
   * unbounded -- 7,320 rows from one 2,400-task workload. 0 disables pruning.
   */
  eventRetentionMs: z.coerce.number().int().nonnegative().default(7 * 24 * 60 * 60 * 1000),
  eventPruneIntervalMs: positiveInt('AGENTOS_EVENT_PRUNE_INTERVAL_MS').default(60 * 60 * 1000),

  // ---- pagination ----------------------------------------------------------
  defaultPageSize: positiveInt('AGENTOS_DEFAULT_PAGE_SIZE').default(100),
  maxPageSize: positiveInt('AGENTOS_MAX_PAGE_SIZE').default(1_000)
});

export type Config = z.infer<typeof ConfigSchema>;

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/**
 * Build config from an environment. Throws a readable aggregate error listing
 * every invalid variable rather than failing on the first.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    leaseMs: env.AGENTOS_LEASE_MS,
    authTokens: env.AGENTOS_AUTH_TOKENS ? csv(env.AGENTOS_AUTH_TOKENS) : undefined,
    requireAuth: bool(env.AGENTOS_REQUIRE_AUTH, false),
    maxBodyBytes: env.AGENTOS_MAX_BODY_BYTES,
    maxOutputBytes: env.AGENTOS_MAX_OUTPUT_BYTES,
    maxTasksPerRun: env.AGENTOS_MAX_TASKS_PER_RUN,
    rateLimitEnabled: bool(env.AGENTOS_RATE_LIMIT_ENABLED, true),
    sharedRateLimit: bool(env.AGENTOS_SHARED_RATE_LIMIT, false),
    rateLimitMax: env.AGENTOS_RATE_LIMIT_MAX,
    rateLimitWindowMs: env.AGENTOS_RATE_LIMIT_WINDOW_MS,
    eventRetentionMs: env.AGENTOS_EVENT_RETENTION_MS,
    eventPruneIntervalMs: env.AGENTOS_EVENT_PRUNE_INTERVAL_MS,
    defaultPageSize: env.AGENTOS_DEFAULT_PAGE_SIZE,
    maxPageSize: env.AGENTOS_MAX_PAGE_SIZE
  };
  // Drop unset keys so zod defaults apply rather than failing on `undefined`.
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined)
  );

  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`INVALID_CONFIGURATION:\n  ${issues.join('\n  ')}`);
  }

  if (parsed.data.requireAuth && parsed.data.authTokens.length === 0) {
    throw new Error(
      'INVALID_CONFIGURATION:\n  AGENTOS_REQUIRE_AUTH is set but AGENTOS_AUTH_TOKENS is empty'
    );
  }
  return parsed.data;
}
