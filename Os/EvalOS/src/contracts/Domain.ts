export type RunStatus = 'CREATED' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
export type CaseExecutionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED';

export interface EvaluationSuite {
  id: string;
  name: string;
  version: string;
  description?: string;
  caseIds: string[];
}

export interface EvaluationCase {
  id: string;
  suiteId: string;
  datasetId?: string;
  input: any;
  expectedBehavior?: any;
  evaluators: string[];
  metrics: string[];
  tags?: string[];
  timeoutMs?: number;
  metadata?: Record<string, any>;
}

export interface Dataset {
  id: string;
  version: string;
  hash?: string;
  caseCount: number;
  metadata?: Record<string, any>;
}

export interface EvaluationRun {
  id: string;
  suiteId: string;
  suiteVersion: string;
  datasetId?: string;
  datasetVersion?: string;
  candidateId: string;
  candidateVersion: string;
  baselineId?: string;
  evaluatorVersions?: Record<string, string>;
  configuration?: Record<string, any>;
  environment?: Record<string, any>;
  status: RunStatus;
  startTime?: Date;
  endTime?: Date;
}

export interface CaseExecution {
  id: string;
  runId: string;
  caseId: string;
  status: CaseExecutionStatus;
  startTime?: Date;
  endTime?: Date;
  result?: any;
  error?: any;
}

export type Operator = '==' | '!=' | '>' | '<' | '>=' | '<=';

export interface QualityGate {
  id: string;
  metric: string;
  operator: Operator;
  thresholdNum?: number;
  thresholdBool?: boolean;
}

export interface QualityGateResult {
  gateId: string;
  metric: string;
  expectedThreshold: any;
  actualValue: any;
  operator: Operator;
  passed: boolean;
  failureReason?: string;
}

export interface RegressionRule {
  id: string;
  metric: string;
  maxAbsoluteDropNum?: number;
  maxRelativeDropPct?: number; // e.g., 0.20 for 20%
}

export type RegressionOutcome = 'PASS' | 'FAIL' | 'WARNING';

export interface RegressionResult {
  ruleId: string;
  metric: string;
  baselineValue: any;
  candidateValue: any;
  absoluteDelta?: number;
  relativeDelta?: number;
  outcome: RegressionOutcome;
  reason: string;
}

export interface MetricAggregation {
  metric: string;
  count: number;
  sum?: number;
  average?: number;
  min?: number;
  max?: number;
  passCount?: number;
  passRate?: number;
}
