import { SuiteRepository } from './SuiteRepository';
import { CaseRepository } from './CaseRepository';
import { DatasetRepository } from './DatasetRepository';
import { RunRepository } from './RunRepository';
import { CaseExecutionRepository } from './CaseExecutionRepository';
import { ScoreRepository } from './ScoreRepository';
import type { Database } from 'better-sqlite3';

export class Repositories {
  public suites: SuiteRepository;
  public cases: CaseRepository;
  public datasets: DatasetRepository;
  public runs: RunRepository;
  public caseExecutions: CaseExecutionRepository;
  public scores: ScoreRepository;

  constructor(db: Database) {
    this.suites = new SuiteRepository(db);
    this.cases = new CaseRepository(db);
    this.datasets = new DatasetRepository(db);
    this.runs = new RunRepository(db);
    this.caseExecutions = new CaseExecutionRepository(db);
    this.scores = new ScoreRepository(db);
  }
}
