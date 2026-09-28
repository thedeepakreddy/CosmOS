import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { Repositories } from '../../src/repositories';

describe('Repository Smoke Tests', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it('SuiteRepository CRUD', () => {
    const suite = {
      id: 'suite-1',
      name: 'Test Suite',
      version: '1.0.0',
      description: 'A test suite',
      caseIds: ['case-1', 'case-2']
    };
    repos.suites.create(suite);
    
    const fetched = repos.suites.getById('suite-1');
    expect(fetched).toEqual(suite);
  });

  it('DatasetRepository CRUD', () => {
    const dataset = {
      id: 'ds-1',
      version: '1.0',
      hash: 'abc',
      caseCount: 10,
      metadata: { source: 'test' }
    };
    repos.datasets.create(dataset);
    
    const fetched = repos.datasets.getById('ds-1');
    expect(fetched).toEqual(dataset);
  });

  it('CaseRepository CRUD', () => {
    // Need suite first for foreign key constraint
    repos.suites.create({ id: 'suite-1', name: 'S', version: '1', caseIds: ['case-1'] });

    const c = {
      id: 'case-1',
      suiteId: 'suite-1',
      input: { text: 'hello' },
      expectedBehavior: { result: 'world' },
      evaluators: ['eval-1'],
      metrics: ['match']
    };
    repos.cases.create(c);

    const fetched = repos.cases.getById('case-1');
    expect(fetched).toMatchObject(c);

    const bySuite = repos.cases.getBySuiteId('suite-1');
    expect(bySuite).toHaveLength(1);
  });

  it('RunRepository CRUD', () => {
    const run = {
      id: 'run-1',
      suiteId: 'suite-1',
      suiteVersion: '1',
      candidateId: 'cand-1',
      candidateVersion: '1',
      status: 'CREATED' as const
    };
    repos.runs.create(run);

    const fetched = repos.runs.getById('run-1');
    expect(fetched?.status).toBe('CREATED');

    repos.runs.updateStatus('run-1', 'RUNNING');
    expect(repos.runs.getById('run-1')?.status).toBe('RUNNING');
  });

  it('CaseExecutionRepository CRUD', () => {
    // Satisfy FKs
    repos.suites.create({ id: 's1', name: 'S', version: '1', caseIds: [] });
    repos.cases.create({ id: 'c1', suiteId: 's1', input: {}, evaluators: [], metrics: [] });
    repos.runs.create({ id: 'r1', suiteId: 's1', suiteVersion: '1', candidateId: 'can1', candidateVersion: '1', status: 'RUNNING' });

    const exec = {
      id: 'exec-1',
      runId: 'r1',
      caseId: 'c1',
      status: 'PENDING' as const
    };
    repos.caseExecutions.create(exec);

    let fetched = repos.caseExecutions.getByRunId('r1');
    expect(fetched).toHaveLength(1);
    expect(fetched[0].status).toBe('PENDING');

    repos.caseExecutions.update('exec-1', { status: 'RUNNING', result: { out: 1 } });
    fetched = repos.caseExecutions.getByRunId('r1');
    expect(fetched[0].status).toBe('RUNNING');
    expect(fetched[0].result).toEqual({ out: 1 });
  });

  it('ScoreRepository CRUD', () => {
    // Satisfy FKs
    repos.suites.create({ id: 's1', name: 'S', version: '1', caseIds: [] });
    repos.cases.create({ id: 'c1', suiteId: 's1', input: {}, evaluators: [], metrics: [] });
    repos.runs.create({ id: 'r1', suiteId: 's1', suiteVersion: '1', candidateId: 'can1', candidateVersion: '1', status: 'RUNNING' });
    repos.caseExecutions.create({ id: 'exec-1', runId: 'r1', caseId: 'c1', status: 'SUCCEEDED' });

    const score = {
      metric: 'accuracy',
      value: 0.95,
      passed: true,
      evaluatorId: 'eval-1',
      evaluatorVersion: '1.0',
      evidence: { match: true }
    };
    repos.scores.create('exec-1', 'r1', score);

    const fetched = repos.scores.getByRunId('r1');
    expect(fetched).toHaveLength(1);
    expect(fetched[0].value).toBe(0.95);
    expect(fetched[0].passed).toBe(true);
    expect(fetched[0].evidence).toEqual({ match: true });
  });
});
