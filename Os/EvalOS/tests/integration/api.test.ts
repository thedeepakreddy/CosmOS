import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../../src/api/server';
import { DeterministicTextCandidate } from '../fixtures/TestCandidates';
import { ExactMatchEvaluator } from '../../src/evaluators/BuiltinEvaluators';
import type { FastifyInstance } from 'fastify';

describe('API Integration Tests', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    // Each test gets a fresh server with a unique on-disk DB
    const dbPath = '/tmp/evalos_api_test_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.db';
    server = await buildServer({ dbPath });
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /health returns healthy', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('0.1.0');
  });

  it('GET /openapi.json returns populated OpenAPI document', async () => {
    const res = await server.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBeDefined();
    expect(body.info.title).toBe('EvalOS API');
  });

  it('POST /v1/suites creates a suite', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/suites',
      payload: { id: 'suite-api-1', name: 'API Test Suite', version: '1.0', caseIds: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('created');
  });

  it('GET /v1/suites/:id returns the suite with populated fields', async () => {
    await server.inject({
      method: 'POST',
      url: '/v1/suites',
      payload: { id: 'suite-api-2', name: 'Suite B', version: '2.0', caseIds: ['c1', 'c2'] },
    });

    const res = await server.inject({ method: 'GET', url: '/v1/suites/suite-api-2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Prove fields are populated — not {}
    expect(body.id).toBe('suite-api-2');
    expect(body.name).toBe('Suite B');
    expect(body.version).toBe('2.0');
    expect(body.caseIds).toEqual(['c1', 'c2']);
  });

  it('GET /v1/suites/:id 404 for missing suite', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/suites/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SUITE_NOT_FOUND');
  });

  it('POST /v1/datasets creates a dataset', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/datasets',
      payload: { id: 'ds-api-1', version: '1.0', caseCount: 5 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('GET /v1/runs/:id/scores returns populated scores array', async () => {
    const repos = server.repos;

    repos.suites.create({ id: 's-score', name: 'S', version: '1', caseIds: ['c-score'] });
    repos.cases.create({ id: 'c-score', suiteId: 's-score', input: {}, evaluators: [], metrics: [] });
    repos.runs.create({
      id: 'r-score',
      suiteId: 's-score',
      suiteVersion: '1',
      candidateId: 'can1',
      candidateVersion: '1',
      status: 'COMPLETED',
    });
    repos.caseExecutions.create({ id: 'exec-score', runId: 'r-score', caseId: 'c-score', status: 'SUCCEEDED' });
    repos.scores.create('exec-score', 'r-score', {
      metric: 'exact_match',
      value: true,
      passed: true,
      evaluatorId: 'eval-exact-match',
      evaluatorVersion: '1.0.0',
      evidence: { expected: 'Paris', actual: 'Paris' },
    });

    const res = await server.inject({ method: 'GET', url: '/v1/runs/r-score/scores' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Prove serialization is correct — no {} empty objects
    expect(body.scores).toHaveLength(1);
    expect(body.scores[0].metric).toBe('exact_match');
    expect(body.scores[0].value).toBe(true);
    expect(body.scores[0].passed).toBe(true);
    expect(body.scores[0].evaluatorId).toBe('eval-exact-match');
    expect(body.scores[0].evidence).toEqual({ expected: 'Paris', actual: 'Paris' });
  });

  it('POST /v1/traces ingests a trace event', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/traces',
      payload: {
        traceId: 'trace-1',
        system: 'AgentOS',
        eventType: 'agent.task.completed',
        timestamp: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('ingested');
  });

  it('Full vertical slice: suite → dataset → run → engine → scores → persistence', async () => {
    const candidate = new DeterministicTextCandidate('Paris', 5);
    const evaluator = new ExactMatchEvaluator();

    const dbPath = '/tmp/evalos_slice_' + Date.now() + '.db';
    const { Repositories } = await import('../../src/repositories');
    const { getDb } = await import('../../src/db/sqlite');
    const { runMigrations } = await import('../../src/db/migrate');
    const { EvaluationEngine } = await import('../../src/engine/EvaluationEngine');

    const db = getDb(dbPath);
    runMigrations(db);
    const repos = new Repositories(db);

    const engine = new EvaluationEngine(
      repos,
      (id) => (id === candidate.id ? candidate : null),
      (id) => (id === evaluator.id ? evaluator : null),
      1,
    );

    repos.suites.create({ id: 'suite-slice', name: 'Slice Suite', version: '1', caseIds: ['case-slice'] });
    repos.cases.create({
      id: 'case-slice',
      suiteId: 'suite-slice',
      input: { question: 'Capital of France?' },
      expectedBehavior: 'Paris',
      evaluators: [evaluator.id],
      metrics: ['exact_match'],
    });
    repos.runs.create({
      id: 'run-slice',
      suiteId: 'suite-slice',
      suiteVersion: '1',
      candidateId: candidate.id,
      candidateVersion: '1',
      status: 'READY',
    });
    repos.caseExecutions.create({
      id: 'exec-slice',
      runId: 'run-slice',
      caseId: 'case-slice',
      status: 'PENDING',
    });

    await engine.startRun('run-slice');

    const run = repos.runs.getById('run-slice');
    expect(run?.status).toBe('COMPLETED');

    const scores = repos.scores.getByRunId('run-slice');
    expect(scores).toHaveLength(1);
    expect(scores[0].metric).toBe('exact_match');
    expect(scores[0].passed).toBe(true);
    expect((scores[0].evidence as any).expected).toBe('Paris');
    expect((scores[0].evidence as any).actual).toBe('Paris');

    // Reopen DB to prove persistence
    db.close();
    const db2 = getDb(dbPath);
    const repos2 = new Repositories(db2);
    const reloaded = repos2.runs.getById('run-slice');
    expect(reloaded?.status).toBe('COMPLETED');
    const reloadedScores = repos2.scores.getByRunId('run-slice');
    expect(reloadedScores[0].passed).toBe(true);
    db2.close();
  });
});
