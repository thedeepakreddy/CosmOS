import { CandidateAdapter, CandidateHealth, EvaluationInput, EvaluationContext, CandidateResult } from '../../src/contracts/Candidate';

export class DeterministicTextCandidate implements CandidateAdapter {
  id = 'fixture-text-candidate';
  
  constructor(private output: string, private latency: number = 10) {}

  async health(): Promise<CandidateHealth> {
    return { status: 'healthy' };
  }

  async execute(input: EvaluationInput, context: EvaluationContext): Promise<CandidateResult> {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve({ output: this.output, latencyMs: this.latency });
      }, this.latency);
    });
  }
}

export class FailingCandidate implements CandidateAdapter {
  id = 'fixture-failing-candidate';

  async health(): Promise<CandidateHealth> {
    return { status: 'healthy' };
  }

  async execute(input: EvaluationInput, context: EvaluationContext): Promise<CandidateResult> {
    return { 
      output: null,
      error: { code: 'SECRET_EVALOS_TEST_123', message: 'Deliberate failure' }
    };
  }
}

export class SlowCandidate implements CandidateAdapter {
  id = 'fixture-slow-candidate';

  constructor(private delayMs: number) {}

  async health(): Promise<CandidateHealth> {
    return { status: 'healthy' };
  }

  async execute(input: EvaluationInput, context: EvaluationContext): Promise<CandidateResult> {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve({ output: 'done', latencyMs: this.delayMs });
      }, this.delayMs);
    });
  }
}

export class StructuredJsonCandidate implements CandidateAdapter {
  id = 'fixture-json-candidate';

  constructor(private output: any) {}

  async health(): Promise<CandidateHealth> {
    return { status: 'healthy' };
  }

  async execute(input: EvaluationInput, context: EvaluationContext): Promise<CandidateResult> {
    return { output: this.output };
  }
}
