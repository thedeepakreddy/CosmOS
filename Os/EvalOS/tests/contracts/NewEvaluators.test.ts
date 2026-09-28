import { describe, it, expect } from 'vitest';
import { StatusEvaluator } from '../../src/evaluators/StatusEvaluator';
import { NumericThresholdEvaluator } from '../../src/evaluators/NumericThresholdEvaluator';

describe('StatusEvaluator', () => {
  const evaluator = new StatusEvaluator();

  it('passes when candidate succeeds and no explicit status expected', async () => {
    const scores = await evaluator.evaluate(
      { output: 'hello' },
      { runId: '1', caseId: '1' },
    );
    expect(scores[0].passed).toBe(true);
    expect(scores[0].value).toBe('SUCCEEDED');
  });

  it('fails when candidate has error and SUCCEEDED expected', async () => {
    const scores = await evaluator.evaluate(
      { output: null, error: { code: 'BOOM' } },
      { runId: '1', caseId: '1', expectedBehavior: 'SUCCEEDED' },
    );
    expect(scores[0].passed).toBe(false);
    expect(scores[0].value).toBe('FAILED');
  });

  it('passes when candidate fails and FAILED is expected', async () => {
    const scores = await evaluator.evaluate(
      { output: null, error: { code: 'BOOM' } },
      { runId: '1', caseId: '1', expectedBehavior: 'FAILED' },
    );
    expect(scores[0].passed).toBe(true);
  });
});

describe('NumericThresholdEvaluator', () => {
  const evaluator = new NumericThresholdEvaluator();

  it('passes when output > threshold', async () => {
    const scores = await evaluator.evaluate(
      { output: 95 },
      { runId: '1', caseId: '1', expectedBehavior: { metric: 'accuracy', operator: '>=', threshold: 90 } },
    );
    expect(scores[0].passed).toBe(true);
    expect(scores[0].metric).toBe('accuracy');
    expect(scores[0].value).toBe(95);
  });

  it('fails when output < threshold', async () => {
    const scores = await evaluator.evaluate(
      { output: 85 },
      { runId: '1', caseId: '1', expectedBehavior: { metric: 'accuracy', operator: '>=', threshold: 90 } },
    );
    expect(scores[0].passed).toBe(false);
  });

  it('fails when output is not a number', async () => {
    const scores = await evaluator.evaluate(
      { output: 'not-a-number' },
      { runId: '1', caseId: '1', expectedBehavior: { metric: 'score', operator: '>', threshold: 50 } },
    );
    expect(scores[0].passed).toBe(false);
    expect(scores[0].evidence).toHaveProperty('error');
  });

  it('throws when expected behavior is incomplete', async () => {
    await expect(
      evaluator.evaluate(
        { output: 95 },
        { runId: '1', caseId: '1', expectedBehavior: { metric: 'score' } },
      ),
    ).rejects.toThrow('requires metric, operator, and threshold');
  });
});
