import { Evaluator, EvaluatorContext, EvaluationScore } from '../contracts/Evaluator';

export class NumericThresholdEvaluator implements Evaluator {
  id = 'eval-numeric-threshold';
  version = '1.0.0';
  type = 'DETERMINISTIC' as const;

  async evaluate(candidateResult: any, context: EvaluatorContext): Promise<EvaluationScore[]> {
    const behavior = context.expectedBehavior as Record<string, unknown> | undefined;
    const metricName = behavior?.metric as string | undefined;
    const operator = behavior?.operator as string | undefined;
    const threshold = behavior?.threshold as number | undefined;
    const actualValue = candidateResult?.output as number | undefined;

    if (metricName === undefined || operator === undefined || threshold === undefined) {
      throw new Error('NumericThresholdEvaluator requires metric, operator, and threshold in expectedBehavior');
    }

    if (typeof actualValue !== 'number') {
      return [
        {
          metric: metricName,
          value: -1,
          passed: false,
          evaluatorId: this.id,
          evaluatorVersion: this.version,
          evidence: { error: 'Candidate output is not a number', actual: actualValue },
        },
      ];
    }

    const passed = this.compare(actualValue, operator, threshold);

    return [
      {
        metric: metricName,
        value: actualValue,
        passed,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: { operator, threshold, actual: actualValue },
      },
    ];
  }

  private compare(actual: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case '>': return actual > threshold;
      case '>=': return actual >= threshold;
      case '<': return actual < threshold;
      case '<=': return actual <= threshold;
      case '==': return actual === threshold;
      case '!=': return actual !== threshold;
      default: throw new Error('Unknown operator: ' + operator);
    }
  }
}
