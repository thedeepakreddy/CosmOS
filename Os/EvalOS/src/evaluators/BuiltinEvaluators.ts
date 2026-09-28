import { Evaluator, EvaluatorContext, EvaluationScore } from '../contracts/Evaluator';
import Ajv from 'ajv';

export class ExactMatchEvaluator implements Evaluator {
  id = 'eval-exact-match';
  version = '1.0.0';
  type = 'DETERMINISTIC' as const;

  async evaluate(candidateResult: any, context: EvaluatorContext): Promise<EvaluationScore[]> {
    const expected = context.expectedBehavior;
    const actual = candidateResult?.output;
    const passed = expected === actual;

    return [
      {
        metric: 'exact_match',
        value: passed,
        passed,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: { expected, actual },
      },
    ];
  }
}

export class JsonSchemaEvaluator implements Evaluator {
  id = 'eval-json-schema';
  version = '1.0.0';
  type = 'DETERMINISTIC' as const;
  private ajv = new Ajv();

  async evaluate(candidateResult: any, context: EvaluatorContext): Promise<EvaluationScore[]> {
    const schema = context.expectedBehavior;
    const actual = candidateResult?.output;

    if (!schema) {
      throw new Error('JsonSchemaEvaluator requires a schema in expectedBehavior');
    }

    const validate = this.ajv.compile(schema);
    const passed = validate(actual) as boolean;

    return [
      {
        metric: 'schema_valid',
        value: passed,
        passed,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: passed ? undefined : { errors: validate.errors },
      },
    ];
  }
}

export class LatencyThresholdEvaluator implements Evaluator {
  id = 'eval-latency-threshold';
  version = '1.0.0';
  type = 'DETERMINISTIC' as const;

  async evaluate(candidateResult: any, context: EvaluatorContext): Promise<EvaluationScore[]> {
    const behavior = context.expectedBehavior as Record<string, unknown> | undefined;
    const maxLatency = behavior?.maxLatencyMs as number | undefined;
    const actual = candidateResult?.latencyMs as number | undefined;

    if (maxLatency === undefined) {
      throw new Error('LatencyThresholdEvaluator requires maxLatencyMs in expectedBehavior');
    }

    if (actual === undefined) {
      return [
        {
          metric: 'latency_ms',
          value: -1,
          passed: false,
          evaluatorId: this.id,
          evaluatorVersion: this.version,
          evidence: { error: 'Latency was not recorded by candidate' },
        },
      ];
    }

    const passed = actual <= maxLatency;
    return [
      {
        metric: 'latency_ms',
        value: actual,
        unit: 'ms',
        passed,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: { maxLatency, actual },
      },
    ];
  }
}

export class ContainsEvaluator implements Evaluator {
  id = 'eval-contains';
  version = '1.0.0';
  type = 'DETERMINISTIC' as const;

  async evaluate(candidateResult: any, context: EvaluatorContext): Promise<EvaluationScore[]> {
    const behavior = context.expectedBehavior as Record<string, unknown> | undefined;
    const expected = behavior?.substring as string | undefined;
    const actual = candidateResult?.output;

    if (typeof expected !== 'string' || typeof actual !== 'string') {
      return [
        {
          metric: 'contains',
          value: false,
          passed: false,
          evaluatorId: this.id,
          evaluatorVersion: this.version,
          evidence: { error: 'Both output and expected substring must be strings' },
        },
      ];
    }

    const passed = actual.includes(expected);

    return [
      {
        metric: 'contains',
        value: passed,
        passed,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: { expected, actual },
      },
    ];
  }
}
