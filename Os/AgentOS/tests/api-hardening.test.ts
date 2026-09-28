import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import { ConfigSchema } from '../src/config';
import { FixedWindowRateLimiter } from '../src/api/rateLimit';
import { AgentOSClient, AgentOSError } from '../src/sdk/client';
import { closeDb } from '../src/db/connection';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase E: rate limiting, pagination, body caps, and SDK/API parity.
 */
describe('Rate limiting (Phase E)', () => {
  describe('the limiter itself', () => {
    it('allows up to the limit, then refuses', () => {
      const now = 1_000;
      const l = new FixedWindowRateLimiter(3, 1_000, () => now);
      expect([l.check('a'), l.check('a'), l.check('a')].every((d) => d.allowed)).toBe(true);
      expect(l.check('a').allowed).toBe(false);
    });

    it('counts each key separately', () => {
      const now = 0;
      const l = new FixedWindowRateLimiter(1, 1_000, () => now);
      expect(l.check('a').allowed).toBe(true);
      expect(l.check('b').allowed).toBe(true);   // different client
      expect(l.check('a').allowed).toBe(false);
    });

    it('resets when the window rolls over', () => {
      let now = 0;
      const l = new FixedWindowRateLimiter(1, 1_000, () => now);
      expect(l.check('a').allowed).toBe(true);
      expect(l.check('a').allowed).toBe(false);
      now = 1_001;
      expect(l.check('a').allowed).toBe(true);
    });

    it('prunes expired windows so the map cannot grow without bound', () => {
      let now = 0;
      const l = new FixedWindowRateLimiter(5, 100, () => now);
      for (let i = 0; i < 500; i++) l.check(`k${i}`);
      expect(l.size).toBe(500);
      now = 1_000;
      l.prune();
      expect(l.size).toBe(0);
    });
  });

  describe('over HTTP', () => {
    const dbPath = testDbPath('ratelimit-http');
    let app: any;
    let base: string;

    beforeAll(async () => {
      removeDb(dbPath);
      process.env.DATABASE_URL = dbPath;
      app = await buildServer({
        executor: new TestAgentExecutor(),
        config: ConfigSchema.parse({ rateLimitEnabled: true, rateLimitMax: 5, rateLimitWindowMs: 60_000 })
      });
      await app.listen({ port: 0 });
      base = `http://127.0.0.1:${app.server.address().port}`;
    });
    afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

    it('refuses with 429 once the budget is spent, in the standard envelope', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await fetch(`${base}/health`)).status);
      expect(codes.filter((c) => c === 200).length).toBe(5);
      expect(codes.filter((c) => c === 429).length).toBe(3);

      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.category).toBe('RATE_LIMITED');
    });

    it('advertises the budget in response headers', async () => {
      const res = await fetch(`${base}/health`);
      expect(res.headers.get('x-ratelimit-limit')).toBe('5');
      expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull();
      expect(res.headers.get('x-ratelimit-reset')).not.toBeNull();
    });
  });
});

describe('Pagination and caps (Phase E)', () => {
  const dbPath = testDbPath('pagination');
  let app: any;
  let base: string;
  let client: AgentOSClient;
  let runId: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: new TestAgentExecutor(),
      config: ConfigSchema.parse({
        rateLimitEnabled: false, defaultPageSize: 10, maxPageSize: 50, maxTasksPerRun: 200
      })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
    client = new AgentOSClient(base);

    await client.createAgent({
      id: 'pg', version: '1', name: 'pg', description: '', role: '', capabilities: []
    });
    const run = await client.createRun({
      goal: 'pagination',
      taskGraph: {
        tasks: Array.from({ length: 35 }, (_, i) => ({
          id: `T${String(i).padStart(3, '0')}`, name: 't', description: '',
          agentDefinitionId: 'pg', state: 'PENDING', retriesAllowed: 0, retriesAttempted: 0
        })),
        dependencies: []
      }
    } as any);
    runId = run.id;
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  it('returns a bounded page, not the whole run', async () => {
    const page = await client.getTasks(runId);
    expect(page.tasks).toHaveLength(10);       // configured default
    expect(page.total).toBe(35);
    expect(page.nextCursor).not.toBeNull();
  });

  it('walks every task exactly once via the cursor', async () => {
    const all = await client.getAllTasks(runId);
    expect(all).toHaveLength(35);
    expect(new Set(all.map((t) => t.id)).size).toBe(35);
    // Keyset order is stable and ascending.
    expect(all.map((t) => t.id)).toEqual([...all.map((t) => t.id)].sort());
  });

  it('clamps an oversized limit to the configured maximum', async () => {
    const page = await client.getTasks(runId, { limit: 10_000 });
    expect(page.tasks.length).toBeLessThanOrEqual(50);
  });

  it('rejects a nonsensical limit', async () => {
    const res = await fetch(`${base}/v1/runs/${runId}/tasks?limit=-5`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a task graph beyond the configured ceiling', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'too big',
        taskGraph: {
          tasks: Array.from({ length: 201 }, (_, i) => ({
            id: `B${i}`, name: 't', description: '', agentDefinitionId: 'pg', state: 'PENDING'
          })),
          dependencies: []
        }
      })
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('GRAPH_TOO_LARGE');
  });

});

describe('Body size cap (Phase E)', () => {
  const dbPath = testDbPath('bodycap');
  let app: any;
  let base: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: new TestAgentExecutor(),
      // A small cap keeps an over-limit body tiny, so the server answers with a
      // proper 413 rather than resetting the connection mid-write.
      config: ConfigSchema.parse({ rateLimitEnabled: false, maxBodyBytes: 2_048 })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  it('refuses an oversized body with the standard envelope', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'x'.repeat(4_000) })
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('BODY_TOO_LARGE');
    expect(body.error.category).toBe('PAYLOAD_TOO_LARGE');
  });

  it('a very large body is refused outright (reset or 413), never processed', async () => {
    let rejected = false;
    try {
      const res = await fetch(`${base}/v1/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: 'x'.repeat(5_000_000) })
      });
      rejected = !res.ok;
    } catch {
      rejected = true;   // a connection reset is also a refusal
    }
    expect(rejected).toBe(true);
  });

  it('a body within the cap is accepted', async () => {
    const res = await fetch(`${base}/v1/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'small', version: '1', name: 's', description: '', role: '', capabilities: [] })
    });
    expect(res.status).toBe(200);
  });
});

describe('SDK / API parity (Phase E)', () => {
  const dbPath = testDbPath('sdk-parity');
  const TOKEN = 'sdk-parity-token-long-enough';
  let app: any;
  let base: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: new TestAgentExecutor(),
      config: ConfigSchema.parse({ authTokens: [TOKEN], rateLimitEnabled: false })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  it('NEGATIVE CONTROL: an unused port must fail', async () => {
    await expect(new AgentOSClient('http://127.0.0.1:39998').health()).rejects.toThrow();
  });

  it('every route has an SDK method (the audit found cancelRun and health missing)', () => {
    const methods = Object.getOwnPropertyNames(AgentOSClient.prototype);
    for (const m of [
      'createAgent', 'getAgent', 'createRun', 'getRun', 'getTasks', 'getAllTasks',
      'getTask', 'startRun', 'pauseRun', 'resumeRun', 'recoverRun', 'cancelRun', 'health'
    ]) {
      expect(methods, `SDK is missing ${m}`).toContain(m);
    }
    // The duplicate that returned the wrong declared type is gone.
    expect(methods).not.toContain('getRunTasks');
  });

  it('carries the bearer token on every call', async () => {
    const client = new AgentOSClient(base, { token: TOKEN });
    await client.createAgent({
      id: 'sdkw', version: '1', name: 'w', description: '', role: '', capabilities: []
    });
    const run = await client.createRun({
      goal: 'sdk',
      taskGraph: {
        tasks: [{ id: 'S1', name: 's', description: '', agentDefinitionId: 'sdkw', state: 'PENDING' }],
        dependencies: []
      }
    } as any);

    await client.startRun(run.id);
    for (let i = 0; i < 80 && (await client.getRun(run.id)).state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await client.getRun(run.id)).state).toBe('COMPLETED');
    expect((await client.getTask(run.id, 'S1')).state).toBe('SUCCEEDED');
    await client.cancelRun(run.id);   // idempotent on a terminal run
    expect((await client.health()).status).toBe('ok');
  });

  it('throws a typed, switchable error', async () => {
    const client = new AgentOSClient(base, { token: TOKEN });
    try {
      await client.getRun('does-not-exist');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentOSError);
      const err = e as AgentOSError;
      expect(err.status).toBe(404);
      expect(err.code).toBe('RUN_NOT_FOUND');
      expect(err.isNotFound).toBe(true);
      expect(err.isUnauthorized).toBe(false);
    }
  });

  it('surfaces an auth failure as a typed 401', async () => {
    const client = new AgentOSClient(base, { token: 'wrong-token-but-long-enough' });
    try {
      await client.getRun('x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentOSError);
      expect((e as AgentOSError).isUnauthorized).toBe(true);
      expect((e as AgentOSError).code).toBe('UNAUTHORIZED');
    }
  });
});
