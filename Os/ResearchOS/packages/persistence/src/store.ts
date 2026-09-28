/**
 * The repository bundle.
 *
 * One object holding every repository over one connection. Callers take this
 * rather than assembling repositories themselves, so a transaction spanning
 * several of them is possible and the wiring lives in one place.
 */
import type { Database } from "./database.ts";
import { ProjectRepository } from "./repositories/project-repository.ts";
import { ResearchRepository } from "./repositories/research-repository.ts";
import { TaskRepository } from "./repositories/task-repository.ts";
import { RunRepository } from "./repositories/run-repository.ts";
import { SqlEventStore } from "./repositories/event-store.ts";
import { MemoryRepository } from "./repositories/memory-repository.ts";
import { GraphRepository } from "./repositories/graph-repository.ts";
import { ExecutorRepository } from "./repositories/executor-repository.ts";
import { ExperimentRepository } from "./repositories/experiment-repository.ts";
import { ReportRepository } from "./repositories/report-repository.ts";

export interface ResearchStore {
  readonly db: Database;
  readonly projects: ProjectRepository;
  readonly research: ResearchRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly events: SqlEventStore;
  readonly memory: MemoryRepository;
  readonly graph: GraphRepository;
  readonly executors: ExecutorRepository;
  readonly experiments: ExperimentRepository;
  readonly reports: ReportRepository;
  /** Runs `fn` with every repository bound to one transaction. */
  transaction<T>(fn: (store: ResearchStore) => Promise<T>): Promise<T>;
}

export function createStore(db: Database, now: () => string = () => new Date().toISOString()): ResearchStore {
  const store: ResearchStore = {
    db,
    projects: new ProjectRepository(db),
    research: new ResearchRepository(db),
    tasks: new TaskRepository(db),
    runs: new RunRepository(db),
    events: new SqlEventStore(db, now),
    memory: new MemoryRepository(db),
    graph: new GraphRepository(db),
    executors: new ExecutorRepository(db),
    experiments: new ExperimentRepository(db),
    reports: new ReportRepository(db),
    transaction: (fn) => db.transaction((tx) => fn(createStore(tx, now))),
  };
  return store;
}
