import { Evaluator, EvaluatorContext, EvaluationScore } from '../contracts/Evaluator';

export class StatusEvaluator implements Evaluator {
  id = 'eval-status';
  version = '1.0.0';
  type = 'DETERMINISTIC' as const;

  async evaluate(candidateResult: any, context: EvaluatorContext): Promise<EvaluationScore[]> {
    const expectedStatus = context.expectedBehavior as string | undefined;
    const actualError = candidateResult?.error;
    const actualStatus = actualError ? 'FAILED' : 'SUCCEEDED';
    const passed = expectedStatus ? actualStatus === expectedStatus : !actualError;

    return [
      {
        metric: 'status',
        value: actualStatus,
        passed,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: { expectedStatus: expectedStatus || 'SUCCEEDED', actualStatus, error: actualError },
      },
    ];
  }
}
