export interface CandidateHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: string;
}

export interface CandidateResult {
  output: unknown;
  latencyMs?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface EvaluationInput {
  data: unknown;
  [key: string]: unknown;
}

export interface EvaluationContext {
  runId: string;
  caseId: string;
}

export interface CandidateAdapter {
  id: string;
  health(): Promise<CandidateHealth>;
  execute(input: EvaluationInput, context: EvaluationContext): Promise<CandidateResult>;
}
