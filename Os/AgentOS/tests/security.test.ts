import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import { loadConfig, ConfigSchema } from '../src/config';
import { LEAK_PATTERNS, toApiError } from '../src/api/errors';
import { closeDb } from '../src/db/connection';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase E: the security boundary.
 *
 * The audit's P0-6: zero auth references in src, a client input error returning
 * HTTP 500 that disclosed `SQLITE_CONSTRAINT_FOREIGNKEY`, and request bodies
 * written to stdout in plaintext.
 */
const TOKEN = 'test-token-that-is-long-enough';
const OTHER = 'another-token-long-enough-too';

describe('Authentication (Phase E)', () => {
  const dbPath = testDbPath('security-auth');
  let app: any;
  let base: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: new TestAgentExecutor(),
      config: ConfigSchema.parse({ authTokens: [TOKEN, OTHER], rateLimitEnabled: false })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);

  it('rejects a request with no credentials', async () => {
    const res = await get('/v1/runs/anything');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.category).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong token, a malformed header, and an empty token', async () => {
    expect((await get('/v1/runs/x', 'not-the-token')).status).toBe(401);
    expect((await fetch(`${base}/v1/runs/x`, { headers: { Authorization: TOKEN } })).status).toBe(401);
    expect((await get('/v1/runs/x', '')).status).toBe(401);
  });

  it('accepts every configured token', async () => {
    for (const token of [TOKEN, OTHER]) {
      // 404 not 401: authentication passed, the run simply does not exist.
      expect((await get('/v1/runs/nope', token)).status).toBe(404);
    }
  });

  it('protects writes as well as reads', async () => {
    const res = await fetch(`${base}/v1/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x', version: '1', name: 'x', description: '', role: '', capabilities: [] })
    });
    expect(res.status).toBe(401);
  });

  it('leaves /health and /docs public for probes', async () => {
    expect((await get('/health')).status).toBe(200);
    expect((await get('/docs/')).status).toBe(200);
  });

  it('a token is never echoed back in any response', async () => {
    const res = await get('/v1/runs/nope', TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
  });
});

describe('Configuration validation (Phase E)', () => {
  it('rejects a non-numeric port with a readable message', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' } as NodeJS.ProcessEnv))
      .toThrow(/INVALID_CONFIGURATION[\s\S]*PORT/);
  });

  it('rejects a negative lease', () => {
    expect(() => loadConfig({ AGENTOS_LEASE_MS: '-5' } as NodeJS.ProcessEnv))
      .toThrow(/INVALID_CONFIGURATION/);
  });

  it('rejects a token that is too short to be a credential', () => {
    expect(() => loadConfig({ AGENTOS_AUTH_TOKENS: 'short' } as NodeJS.ProcessEnv))
      .toThrow(/at least 16 characters/);
  });

  it('AGENTOS_REQUIRE_AUTH with no tokens is a hard startup failure', () => {
    expect(() => loadConfig({ AGENTOS_REQUIRE_AUTH: 'true' } as NodeJS.ProcessEnv))
      .toThrow(/AGENTOS_REQUIRE_AUTH is set but AGENTOS_AUTH_TOKENS is empty/);
  });

  it('applies documented defaults when nothing is set', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.port).toBe(3000);
    expect(c.leaseMs).toBe(30_000);
    expect(c.authTokens).toEqual([]);
    expect(c.rateLimitEnabled).toBe(true);
  });

  it('parses a comma-separated token list', () => {
    const c = loadConfig({ AGENTOS_AUTH_TOKENS: `${TOKEN}, ${OTHER}` } as NodeJS.ProcessEnv);
    expect(c.authTokens).toEqual([TOKEN, OTHER]);
  });
});

describe('Error sanitization (Phase E)', () => {
  const dbPath = testDbPath('security-errors');
  let app: any;
  let base: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: new TestAgentExecutor(),
      config: ConfigSchema.parse({ rateLimitEnabled: false })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
    await fetch(`${base}/v1/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'se', version: '1', name: 's', description: '', role: '', capabilities: [] })
    });
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  const assertClean = (text: string) => {
    for (const pattern of LEAK_PATTERNS) {
      expect(pattern.test(text), `response leaked ${pattern}: ${text.slice(0, 200)}`).toBe(false);
    }
  };

  it('an unknown dependency is a 400, and discloses nothing about the database', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'ghost',
        taskGraph: {
          tasks: [{ id: 'G', name: 'g', description: '', agentDefinitionId: 'se', state: 'PENDING' }],
          dependencies: [{ taskId: 'G', dependsOn: 'NOPE' }]
        }
      })
    });
    expect(res.status).toBe(400);      // v0.1: 500
    assertClean(await res.text());     // v0.1: SQLITE_CONSTRAINT_FOREIGNKEY
  });

  it('every error path returns the same envelope and leaks nothing', async () => {
    const probes: Array<[string, RequestInit]> = [
      ['/v1/runs/does-not-exist', {}],
      ['/v1/agents/does-not-exist', {}],
      ['/v1/runs/does-not-exist/tasks', {}],
      ['/v1/runs/a/tasks/b', {}],
      ['/v1/unknown-route', {}],
      ['/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' }],
      ['/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
      ['/v1/runs/does-not-exist/start', { method: 'POST' }]
    ];
    for (const [path, init] of probes) {
      const res = await fetch(`${base}${path}`, init);
      const text = await res.text();
      expect(res.ok, `${path} unexpectedly succeeded`).toBe(false);
      assertClean(text);
      const body = JSON.parse(text);
      expect(body.error, `${path} did not use the error envelope`).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(typeof body.error.category).toBe('string');
    }
  });

  it('status codes carry meaning', async () => {
    // v0.1 returned 400 for not-found and 200 for an unknown run's task list.
    expect((await fetch(`${base}/v1/runs/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/runs/nope/tasks`)).status).toBe(404);
    expect((await fetch(`${base}/v1/runs/nope/start`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/v1/unknown`)).status).toBe(404);
  });

  it('an unrecognised internal error becomes an opaque 500', () => {
    const api = toApiError(new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'));
    expect(api.status).toBe(500);
    expect(api.code).toBe('INTERNAL_ERROR');
    expect(api.message).toBe('An internal error occurred');
    for (const p of LEAK_PATTERNS) expect(p.test(JSON.stringify(api.toBody()))).toBe(false);
  });

  it('a stack trace is never mapped onto the wire', () => {
    const err = new Error('boom');
    const api = toApiError(err);
    expect(JSON.stringify(api.toBody())).not.toContain('at ');
    expect(JSON.stringify(api.toBody())).not.toContain(__filename);
  });
});

describe('Input validation without coercion (Phase E)', () => {
  const dbPath = testDbPath('security-validation');
  let app: any;
  let base: string;

  beforeAll(async () => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    app = await buildServer({
      executor: new TestAgentExecutor(),
      config: ConfigSchema.parse({ rateLimitEnabled: false })
    });
    await app.listen({ port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  afterAll(async () => { await app.close(); closeDb(); removeDb(dbPath); });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });

  it('wrong types are REJECTED, not silently coerced', async () => {
    // The audit: this exact body returned 200 with id "1" and capabilities ["no"].
    const res = await post('/v1/agents', {
      id: 1, version: 2, name: 3, description: 4, role: 5, capabilities: 'no'
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/id|capabilities/);
  });

  it('a numeric string is not coerced into a number', async () => {
    const res = await post('/v1/runs', { goal: 'g', budget: { maxTasks: '5' } });
    expect(res.status).toBe(400);
  });

  it('a negative budget is rejected at the boundary', async () => {
    expect((await post('/v1/runs', { goal: 'g', budget: { maxTasks: -1 } })).status).toBe(400);
  });

  it('unknown top-level fields are rejected rather than ignored', async () => {
    expect((await post('/v1/runs', { goal: 'g', notAField: true })).status).toBe(400);
  });

  it('client-supplied ownership fields cannot grant ownership', async () => {
    const res = await post('/v1/runs', {
      goal: 'forge',
      taskGraph: {
        tasks: [{
          id: 'F', name: 'f', description: '', agentDefinitionId: 'x', state: 'PENDING',
          ownerId: 'attacker', fence: 999, attempt: 999, leaseExpiresAt: Date.now() + 1e9
        }],
        dependencies: []
      }
    });
    // Rejected outright: ownership fields are not part of the accepted input shape.
    expect(res.status).toBe(400);
  });

  it('a valid body still works', async () => {
    const res = await post('/v1/agents', {
      id: 'ok', version: '1', name: 'ok', description: '', role: '', capabilities: []
    });
    expect(res.status).toBe(200);
  });
});
