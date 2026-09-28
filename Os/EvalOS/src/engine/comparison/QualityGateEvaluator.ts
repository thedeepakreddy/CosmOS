import { MetricAggregation, QualityGate, QualityGateResult } from '../../contracts/Domain';

export class QualityGateEvaluator {
  evaluate(aggregations: MetricAggregation[], gates: QualityGate[]): QualityGateResult[] {
    const results: QualityGateResult[] = [];

    const aggMap = new Map(aggregations.map(a => [a.metric, a]));

    for (const gate of gates) {
      const agg = aggMap.get(gate.metric);
      
      if (!agg) {
        results.push({
          gateId: gate.id,
          metric: gate.metric,
          expectedThreshold: gate.thresholdNum ?? gate.thresholdBool,
          actualValue: null,
          operator: gate.operator,
          passed: false,
          failureReason: `Metric ${gate.metric} was not produced in this run`
        });
        continue;
      }

      // Determine actual value (prefer average for numbers, passRate for booleans if applicable)
      // For simplicity, if threshold is number, compare to average or passRate (which is a number)
      let actualValue: number | undefined;
      
      if (gate.thresholdNum !== undefined) {
        // If the metric was boolean pass/fail, we compare passRate
        // If it was latency (num), we compare average
        actualValue = agg.passRate !== undefined ? agg.passRate : agg.average;
      }

      if (actualValue === undefined) {
        results.push({
          gateId: gate.id,
          metric: gate.metric,
          expectedThreshold: gate.thresholdNum ?? gate.thresholdBool,
          actualValue: null,
          operator: gate.operator,
          passed: false,
          failureReason: `No numeric or passRate value available for ${gate.metric}`
        });
        continue;
      }

      const passed = this.compare(actualValue, gate.operator, gate.thresholdNum!);
      results.push({
        gateId: gate.id,
        metric: gate.metric,
        expectedThreshold: gate.thresholdNum,
        actualValue,
        operator: gate.operator,
        passed,
        failureReason: passed ? undefined : `${gate.metric} ${actualValue} does not satisfy ${gate.operator} ${gate.thresholdNum}`
      });
    }

    return results;
  }

  private compare(actual: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case '==': return actual === threshold;
      case '!=': return actual !== threshold;
      case '>': return actual > threshold;
      case '<': return actual < threshold;
      case '>=': return actual >= threshold;
      case '<=': return actual <= threshold;
      default: return false;
    }
  }
}
