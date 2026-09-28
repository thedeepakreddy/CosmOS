import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { Repositories } from '../../src/repositories';
import { EvaluationEngine } from '../../src/engine/EvaluationEngine';
import { DeterministicTextCandidate, SlowCandidate, FailingCandidate, StructuredJsonCandidate } from '../fixtures/TestCandidates';
import { ExactMatchEvaluator, JsonSchemaEvaluator, LatencyThresholdEvaluator } from '../../src/evaluators/BuiltinEvaluators';
import { CandidateAdapter } from '../../src/contracts/Candidate';
import { Evaluator } from '../../src/contracts/Evaluator';

describe('Evaluation Engine Acceptance Tests', () => {
  let db: Database.Database;
  let repos: Repositories;
  let candidates: Record<string, CandidateAdapter>;
  let evaluators: Record<string, Evaluator>;
  let engine: EvaluationEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    candidates = {
      'text-cand': new DeterministicTextCandidate('Paris', 5),
      'slow-cand': new SlowCandidate(100),
      'fail-cand': new FailingCandidate(),
      'json-cand': new StructuredJsonCandidate({ name: 'Eval', valid: true }),
      'bad-json': new StructuredJsonCandidate({ name: 123 })
    };

    const ex = new ExactMatchEvaluator();
    const jschema = new JsonSchemaEvaluator();
    const lat = new LatencyThresholdEvaluator();

    evaluators = {
      [ex.id]: ex,
      [jschema.id]: jschema,
      [lat.id]: lat
    };

    engine = new EvaluationEngine(
      repos,
      (id) => candidates[id] || null,
      (id) => evaluators[id] || null,
      2
    );
  });

  afterEach(() => {
    db.close();
  });

  function setupRun(candidateId: string, input: any, expected: any, evaluatorIds: string[], timeoutMs?: number) {
    repos.suites.create({ id: 's1', name: 'Suite 1', version: '1', caseIds: ['c1'] });
    repos.cases.create({ id: 'c1', suiteId: 's1', input, expectedBehavior: expected, evaluators: evaluatorIds, metrics: [] });
    repos.runs.create({ id: 'r1', suiteId: 's1', suiteVersion: '1', candidateId, candidateVersion: '1', status: 'READY' });
    repos.caseExecutions.create({ id: 'e1', runId: 'r1', caseId: 'c1', status: 'PENDING' });
  }

  it('Scenario A - Exact Match: candidate returns matching string -> PASS', async () => {
    setupRun('text-cand', 'Capital?', 'Paris', ['eval-exact-match']);
    await engine.startRun('r1');

    const scores = repos.scores.getByRunId('r1');
    expect(scores).toHaveLength(1);
    expect(scores[0].metric).toBe('exact_match');
    expect(scores[0].passed).toBe(true);
    
    const execs = repos.caseExecutions.getByRunId('r1');
    expect(execs[0].status).toBe('SUCCEEDED');
  });

  it('Scenario B - JSON Schema: candidate returns valid JSON -> PASS', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    setupRun('json-cand', 'Data?', schema, ['eval-json-schema']);
    await engine.startRun('r1');

    const scores = repos.scores.getByRunId('r1');
    expect(scores[0].passed).toBe(true);
  });

  it('Scenario B - JSON Schema: candidate returns invalid JSON -> FAIL', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    setupRun('bad-json', 'Data?', schema, ['eval-json-schema']);
    await engine.startRun('r1');

    const scores = repos.scores.getByRunId('r1');
    expect(scores[0].passed).toBe(false);
    expect(scores[0].evidence).toBeDefined(); // should contain Ajv errors
  });

  it('Scenario C - Candidate Failure: candidate deliberately throws -> FAILED', async () => {
    setupRun('fail-cand', 'Data?', null, []);
    await engine.startRun('r1');

    const execs = repos.caseExecutions.getByRunId('r1');
    expect(execs[0].status).toBe('FAILED');
    expect(execs[0].error.code).toBe('CANDIDATE_FAILED');
  });

  it('Scenario D - Timeout: slow candidate exceeds timeout -> TIMED_OUT', async () => {
    setupRun('slow-cand', 'Data?', null, [], 10);
    // Overwrite the case timeout since setupRun didn't pass it properly (wait, I need to update setupRun or manually)
    repos.cases.create({ id: 'c2', suiteId: 's1', input: {}, evaluators: [], metrics: [], timeoutMs: 20 });
    repos.caseExecutions.create({ id: 'e2', runId: 'r1', caseId: 'c2', status: 'PENDING' });
    
    await engine.startRun('r1');

    const exec = repos.caseExecutions.getByRunId('r1').find(e => e.id === 'e2');
    expect(exec?.status).toBe('TIMED_OUT');
  });

  it('Scenario E - Latency: measure elapsed candidate duration', async () => {
    setupRun('slow-cand', 'Data?', { maxLatencyMs: 200 }, ['eval-latency-threshold']);
    await engine.startRun('r1');

    const scores = repos.scores.getByRunId('r1');
    expect(scores[0].metric).toBe('latency_ms');
    expect(scores[0].value).toBeGreaterThanOrEqual(100);
    expect(scores[0].passed).toBe(true); // 100 <= 200
  });

  it('Concurrency - Bounded concurrency limits active executions', async () => {
    // Setup suite with 10 cases
    repos.suites.create({ id: 's-many', name: 'Many', version: '1', caseIds: Array.from({length: 10}, (_, i) => `c${i}`) });
    for (let i = 0; i < 10; i++) {
      repos.cases.create({ id: `c${i}`, suiteId: 's-many', input: {}, evaluators: [], metrics: [] });
    }
    repos.runs.create({ id: 'r-many', suiteId: 's-many', suiteVersion: '1', candidateId: 'slow-cand', candidateVersion: '1', status: 'READY' });
    for (let i = 0; i < 10; i++) {
      repos.caseExecutions.create({ id: `e${i}`, runId: 'r-many', caseId: `c${i}`, status: 'PENDING' });
    }

    let activeCount = 0;
    let maxActive = 0;

    // We can spy on Candidate.execute to track concurrency
    const originalExecute = candidates['slow-cand'].execute.bind(candidates['slow-cand']);
    vi.spyOn(candidates['slow-cand'], 'execute').mockImplementation(async (input, ctx) => {
      activeCount++;
      if (activeCount > maxActive) maxActive = activeCount;
      const res = await originalExecute(input, ctx);
      activeCount--;
      return res;
    });

    await engine.startRun('r-many');

    // Engine max concurrency was set to 2 in beforeEach
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
    const run = repos.runs.getById('r-many');
    expect(run?.status).toBe('COMPLETED');
  });
});
