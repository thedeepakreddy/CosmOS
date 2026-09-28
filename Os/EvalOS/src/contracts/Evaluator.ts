export type EvaluatorType = 'DETERMINISTIC' | 'RULE_BASED' | 'MODEL_JUDGE' | 'HUMAN' | 'HYBRID';

export interface EvaluationScore {
  metric: string;
  value: number | boolean | string;
  unit?: string;
  passed?: boolean;
  evaluatorId: string;
  evaluatorVersion: string;
  evidence?: unknown;
}

export interface EvaluatorContext {
  runId: string;
  caseId: string;
  expectedBehavior?: unknown;
}

export interface Evaluator {
  id: string;
  version: string;
  type: EvaluatorType;

  evaluate(
    candidateResult: unknown,
    context: EvaluatorContext
  ): Promise<EvaluationScore[]>;
}
