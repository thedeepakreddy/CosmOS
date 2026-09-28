import { getDb } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrate';
import { Repositories } from '../src/repositories';
import * as path from 'path';
import * as fs from 'fs';

const dbPath = path.join(process.cwd(), 'durability_test.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

{
  const db = getDb(dbPath);
  runMigrations(db);
  const repos = new Repositories(db);
  
  repos.suites.create({ id: 'suite-x', name: 'X', version: '1', caseIds: ['case-x'] });
  repos.cases.create({ id: 'case-x', suiteId: 'suite-x', input: {}, evaluators: [], metrics: [] });
  repos.runs.create({ id: 'run-x', suiteId: 'suite-x', suiteVersion: '1', candidateId: 'c1', candidateVersion: '1', status: 'COMPLETED' });
  repos.caseExecutions.create({ id: 'exec-x', runId: 'run-x', caseId: 'case-x', status: 'SUCCEEDED' });
  repos.scores.create('exec-x', 'run-x', { metric: 'score', value: 99, evaluatorId: 'e1', evaluatorVersion: '1' });
  db.close();
}

{
  const db = getDb(dbPath);
  const repos = new Repositories(db);
  const run = repos.runs.getById('run-x');
  if (!run || run.status !== 'COMPLETED') throw new Error('Run missing');
  const scores = repos.scores.getByRunId('run-x');
  if (scores.length !== 1 || scores[0].value !== 99) throw new Error('Score missing');
  console.log('Durability Test: VERIFIED');
  db.close();
}
