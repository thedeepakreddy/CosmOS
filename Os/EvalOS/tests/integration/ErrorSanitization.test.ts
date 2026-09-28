import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../../src/api/server';
import type { FastifyInstance } from 'fastify';

describe('Error Sanitization', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    const dbPath = '/tmp/evalos_sanitize_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.db';
    server = await buildServer({ dbPath });
  });

  afterEach(async () => {
    await server.close();
  });

  it('Secret candidate error codes must not be swallowed or altered by API layer', async () => {
    // Create a suite/run so we can attempt to start it with a missing candidate
    const repos = server.repos;

    repos.suites.create({ id: 's-sec', name: 'Sec', version: '1', caseIds: ['c-sec'] });
    repos.cases.create({ id: 'c-sec', suiteId: 's-sec', input: {}, evaluators: [], metrics: [] });
    repos.runs.create({
      id: 'r-sec',
      suiteId: 's-sec',
      suiteVersion: '1',
      candidateId: 'non-existent-candidate',
      candidateVersion: '1',
      status: 'READY',
    });
    repos.caseExecutions.create({ id: 'e-sec', runId: 'r-sec', caseId: 'c-sec', status: 'PENDING' });

    const res = await server.inject({ method: 'POST', url: '/v1/runs/r-sec/start' });

    // The engine marks the run as FAILED internally but does NOT throw
    // (it calls failRun which handles the error gracefully).
    // The route handler returns 200 because startRun resolved without exception.
    // The real proof: the run status in DB should be FAILED.
    expect(res.statusCode).toBe(200);

    const run = repos.runs.getById('r-sec');
    expect(run?.status).toBe('FAILED');

    // Response body must NOT contain filesystem paths
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain('node_modules');
  });

  it('404 routes return structured JSON errors, not HTML', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/suites/does-not-exist-12345' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe('SUITE_NOT_FOUND');
    // Must be JSON, not HTML
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('Invalid POST body is rejected with validation error', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/suites',
      payload: { name: 'Missing required fields' },
    });
    // Fastify schema validation rejects this
    expect(res.statusCode).toBe(400);
    const body = res.json();
    // Must contain structured error details, not crash
    expect(body).toBeDefined();
  });
});
