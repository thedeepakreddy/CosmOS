import { describe, it, expect } from 'vitest';
import { ExactMatchEvaluator, JsonSchemaEvaluator } from '../../src/evaluators/BuiltinEvaluators';

describe('Evaluator Contract', () => {
  it('ExactMatchEvaluator obeys contract', async () => {
    const e = new ExactMatchEvaluator();
    expect(e.id).toBeDefined();
    expect(e.version).toBeDefined();
    expect(e.type).toBe('DETERMINISTIC');

    const scores = await e.evaluate({ output: 'ABC' }, { runId: '1', caseId: '1', expectedBehavior: 'ABC' });
    expect(scores).toHaveLength(1);
    expect(scores[0].metric).toBe('exact_match');
    expect(scores[0].passed).toBe(true);
    expect(scores[0].evaluatorId).toBe(e.id);
  });

  it('JsonSchemaEvaluator obeys contract', async () => {
    const e = new JsonSchemaEvaluator();
    const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
    
    const scores = await e.evaluate({ output: { x: 1 } }, { runId: '1', caseId: '1', expectedBehavior: schema });
    expect(scores[0].passed).toBe(true);

    const badScores = await e.evaluate({ output: { y: 1 } }, { runId: '1', caseId: '1', expectedBehavior: schema });
    expect(badScores[0].passed).toBe(false);
    expect(badScores[0].evidence).toBeDefined(); // error details
  });
});
