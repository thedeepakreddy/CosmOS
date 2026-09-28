import { describe, it, expect } from 'vitest';
import { AggregationEngine } from '../../src/engine/comparison/AggregationEngine';
import { RegressionDetector } from '../../src/engine/comparison/RegressionDetector';
import { QualityGateEvaluator } from '../../src/engine/comparison/QualityGateEvaluator';
import { EvaluationScore } from '../../src/contracts/Evaluator';
import { QualityGate, RegressionRule } from '../../src/contracts/Domain';

describe('Regression and Comparison Acceptance Tests', () => {
  const aggregator = new AggregationEngine();
  const regressionDetector = new RegressionDetector();
  const gateEvaluator = new QualityGateEvaluator();

  it('Calculates aggregate metrics from scores', () => {
    const scores: EvaluationScore[] = [
      { metric: 'success_rate', value: true, passed: true, evaluatorId: 'e1', evaluatorVersion: '1' },
      { metric: 'success_rate', value: true, passed: true, evaluatorId: 'e1', evaluatorVersion: '1' },
      { metric: 'success_rate', value: false, passed: false, evaluatorId: 'e1', evaluatorVersion: '1' },
      { metric: 'latency_ms', value: 100, passed: true, evaluatorId: 'e2', evaluatorVersion: '1' },
      { metric: 'latency_ms', value: 200, passed: true, evaluatorId: 'e2', evaluatorVersion: '1' },
    ];

    const aggs = aggregator.aggregateScores(scores);
    
    const sr = aggs.find(a => a.metric === 'success_rate');
    expect(sr?.count).toBe(3);
    expect(sr?.passCount).toBe(2);
    expect(sr?.passRate).toBeCloseTo(0.666, 2);

    const lat = aggs.find(a => a.metric === 'latency_ms');
    expect(lat?.average).toBe(150);
  });

  it('Evaluates Quality Gates', () => {
    const aggs = [
      { metric: 'success_rate', count: 10, passCount: 9, passRate: 0.90 },
      { metric: 'latency_ms', count: 10, average: 850 }
    ];

    const gates: QualityGate[] = [
      { id: 'g1', metric: 'success_rate', operator: '>=', thresholdNum: 0.90 },
      { id: 'g2', metric: 'latency_ms', operator: '<=', thresholdNum: 800 }
    ];

    const results = gateEvaluator.evaluate(aggs, gates);

    const r1 = results.find(r => r.gateId === 'g1');
    expect(r1?.passed).toBe(true);

    const r2 = results.find(r => r.gateId === 'g2');
    expect(r2?.passed).toBe(false);
    expect(r2?.failureReason).toContain('850 does not satisfy <= 800');
  });

  it('Detects Regressions (Scenario F - Regression)', () => {
    // Baseline: 90% pass rate
    const baseAggs = [{ metric: 'success_rate', count: 10, passRate: 0.90 }];
    // Candidate: 70% pass rate
    const candAggs = [{ metric: 'success_rate', count: 10, passRate: 0.70 }];

    const rules: RegressionRule[] = [
      // Max absolute drop of 5 percentage points (0.05)
      { id: 'r1', metric: 'success_rate', maxAbsoluteDropNum: 0.05 }
    ];

    const results = regressionDetector.detect(baseAggs, candAggs, rules);
    
    expect(results[0].outcome).toBe('FAIL');
    expect(results[0].reason).toContain('Absolute drop of 0.2000 exceeds allowed 0.05');
  });

  it('Detects Regressions (Scenario G - Improvement)', () => {
    // Baseline: 70% pass rate
    const baseAggs = [{ metric: 'success_rate', count: 10, passRate: 0.70 }];
    // Candidate: 90% pass rate
    const candAggs = [{ metric: 'success_rate', count: 10, passRate: 0.90 }];

    const rules: RegressionRule[] = [
      { id: 'r1', metric: 'success_rate', maxAbsoluteDropNum: 0.05 }
    ];

    const results = regressionDetector.detect(baseAggs, candAggs, rules);
    
    expect(results[0].outcome).toBe('PASS');
    expect(results[0].reason).toContain('Improvement over baseline');
  });
});
