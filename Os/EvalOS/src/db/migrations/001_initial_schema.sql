-- Suites
CREATE TABLE suites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  case_ids TEXT NOT NULL, -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Datasets
CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  hash TEXT,
  case_count INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT -- JSON
);

-- Cases
CREATE TABLE evaluation_cases (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  dataset_id TEXT,
  input TEXT NOT NULL, -- JSON
  expected_behavior TEXT, -- JSON
  evaluators TEXT NOT NULL, -- JSON array of evaluator references
  metrics TEXT NOT NULL, -- JSON array
  tags TEXT, -- JSON array
  timeout_ms INTEGER,
  metadata TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(suite_id) REFERENCES suites(id)
);

-- Runs
CREATE TABLE evaluation_runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  dataset_id TEXT,
  dataset_version TEXT,
  candidate_id TEXT NOT NULL,
  candidate_version TEXT NOT NULL,
  baseline_id TEXT,
  evaluator_versions TEXT, -- JSON
  configuration TEXT, -- JSON
  environment TEXT, -- JSON
  status TEXT NOT NULL,
  start_time DATETIME,
  end_time DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Case Executions
CREATE TABLE case_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL,
  start_time DATETIME,
  end_time DATETIME,
  result TEXT, -- JSON
  error TEXT, -- JSON
  FOREIGN KEY(run_id) REFERENCES evaluation_runs(id),
  FOREIGN KEY(case_id) REFERENCES evaluation_cases(id)
);

-- Scores
CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value_num REAL,
  value_bool INTEGER,
  value_str TEXT,
  unit TEXT,
  passed INTEGER,
  evaluator_id TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  evidence TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(execution_id) REFERENCES case_executions(id),
  FOREIGN KEY(run_id) REFERENCES evaluation_runs(id)
);

-- Events
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
