import { describe, it, expect } from 'vitest';
import { DeterministicTextCandidate, SlowCandidate, FailingCandidate, StructuredJsonCandidate } from '../../tests/fixtures/TestCandidates';

describe('CandidateAdapter Contract', () => {
  it('DeterministicTextCandidate obeys contract', async () => {
    const c = new DeterministicTextCandidate('test', 0);
    const health = await c.health();
    expect(health.status).toBe('healthy');
    
    const res = await c.execute({ data: '?' }, { runId: '1', caseId: '1' });
    expect(res.output).toBe('test');
    expect(res.latencyMs).toBe(0);
  });

  it('FailingCandidate obeys contract', async () => {
    const c = new FailingCandidate();
    const health = await c.health();
    expect(health.status).toBe('healthy'); // we mocked it healthy in fixtures earlier to allow engine execution test

    const res = await c.execute({ data: '?' }, { runId: '1', caseId: '1' });
    expect(res.output).toBeNull();
    expect(res.error?.code).toBe('SECRET_EVALOS_TEST_123');
  });

  it('StructuredJsonCandidate obeys contract', async () => {
    const c = new StructuredJsonCandidate({ x: 1 });
    const res = await c.execute({ data: '?' }, { runId: '1', caseId: '1' });
    expect(res.output).toEqual({ x: 1 });
  });
});
