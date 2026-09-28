import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { Repositories } from '../../src/repositories';
import { EvaluationEngine } from '../../src/engine/EvaluationEngine';
import { DeterministicTextCandidate } from '../fixtures/TestCandidates';
import { ExactMatchEvaluator } from '../../src/evaluators/BuiltinEvaluators';

describe('Multi-Run Isolation', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repos = new Repositories(db);

  const candidate = new DeterministicTextCandidate('Paris', 0);
  const evaluator = new ExactMatchEvaluator();

  const engine = new EvaluationEngine(
    repos,
    (id) => (id === candidate.id ? candidate : null),
    (id) => (id === evaluator.id ? evaluator : null),
    2,
  );

  afterAll(() => db.close());

  it('Two runs on the same suite produce independent scores', async () => {
    // Shared suite and case
    repos.suites.create({ id: 's-iso', name: 'Iso', version: '1', caseIds: ['c-iso'] });
    repos.cases.create({
      id: 'c-iso',
      suiteId: 's-iso',
      input: 'What?',
      expectedBehavior: 'Paris',
      evaluators: [evaluator.id],
      metrics: ['exact_match'],
    });

    // Run A
    repos.runs.create({
      id: 'run-A',
      suiteId: 's-iso',
      suiteVersion: '1',
      candidateId: candidate.id,
      candidateVersion: '1',
      status: 'READY',
    });
    repos.caseExecutions.create({ id: 'exec-A', runId: 'run-A', caseId: 'c-iso', status: 'PENDING' });

    // Run B
    repos.runs.create({
      id: 'run-B',
      suiteId: 's-iso',
      suiteVersion: '1',
      candidateId: candidate.id,
      candidateVersion: '1',
      status: 'READY',
    });
    repos.caseExecutions.create({ id: 'exec-B', runId: 'run-B', caseId: 'c-iso', status: 'PENDING' });

    // Execute both runs
    await engine.startRun('run-A');
    await engine.startRun('run-B');

    // Verify isolation: each run has its OWN scores
    const scoresA = repos.scores.getByRunId('run-A');
    const scoresB = repos.scores.getByRunId('run-B');

    expect(scoresA).toHaveLength(1);
    expect(scoresB).toHaveLength(1);

    // Run A scores do not leak into Run B
    expect(scoresA[0].metric).toBe('exact_match');
    expect(scoresB[0].metric).toBe('exact_match');

    // Verify runs are independently COMPLETED
    const runA = repos.runs.getById('run-A');
    const runB = repos.runs.getById('run-B');
    expect(runA?.status).toBe('COMPLETED');
    expect(runB?.status).toBe('COMPLETED');

    // Case executions are also independent
    const execsA = repos.caseExecutions.getByRunId('run-A');
    const execsB = repos.caseExecutions.getByRunId('run-B');
    expect(execsA).toHaveLength(1);
    expect(execsB).toHaveLength(1);
    expect(execsA[0].id).toBe('exec-A');
    expect(execsB[0].id).toBe('exec-B');
  });
});
