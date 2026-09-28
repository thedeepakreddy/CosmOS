export interface JudgeRequest {
  candidateOutput: unknown;
  expectedBehavior?: unknown;
  rubric?: JudgeRubric;
  metadata?: Record<string, unknown>;
}

export interface JudgeResult {
  score: number;
  reasoning: string;
  confidence?: number;
  rubricVersion?: string;
  modelId?: string;
  promptVersion?: string;
  raw?: unknown;
}

export interface JudgeRubric {
  id: string;
  version: string;
  description: string;
  levels: RubricLevel[];
}

export interface RubricLevel {
  score: number;
  label: string;
  description: string;
}

export interface JudgeHealth {
  status: 'available' | 'unavailable' | 'unknown';
  reason?: string;
}

export interface JudgeProvider {
  id: string;
  health(): Promise<JudgeHealth>;
  judge(request: JudgeRequest): Promise<JudgeResult>;
}
