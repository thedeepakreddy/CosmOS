import { MetricAggregation, RegressionRule, RegressionResult, RegressionOutcome } from '../../contracts/Domain';

export class RegressionDetector {
  detect(
    baselineAggregations: MetricAggregation[],
    candidateAggregations: MetricAggregation[],
    rules: RegressionRule[]
  ): RegressionResult[] {
    const results: RegressionResult[] = [];
    const baselineMap = new Map(baselineAggregations.map(a => [a.metric, a]));
    const candidateMap = new Map(candidateAggregations.map(a => [a.metric, a]));

    for (const rule of rules) {
      const baseAgg = baselineMap.get(rule.metric);
      const candAgg = candidateMap.get(rule.metric);

      if (!baseAgg || !candAgg) {
        results.push({
          ruleId: rule.id,
          metric: rule.metric,
          baselineValue: null,
          candidateValue: null,
          outcome: 'WARNING',
          reason: `Metric ${rule.metric} is missing from baseline or candidate run`
        });
        continue;
      }

      // Default to checking passRate (e.g. success rate), fallback to average (e.g. latency)
      const baseValue = baseAgg.passRate !== undefined ? baseAgg.passRate : baseAgg.average;
      const candValue = candAgg.passRate !== undefined ? candAgg.passRate : candAgg.average;

      if (baseValue === undefined || candValue === undefined) {
        results.push({
          ruleId: rule.id,
          metric: rule.metric,
          baselineValue: null,
          candidateValue: null,
          outcome: 'WARNING',
          reason: `Cannot compute regression for non-numeric metric ${rule.metric}`
        });
        continue;
      }

      // Determine absolute and relative deltas
      // For success rates (higher is better), drop = baseValue - candValue
      // For latencies (lower is better), drop = candValue - baseValue
      // We assume rule specifies "max absolute drop".
      // To be robust, let's say positive delta is improvement, negative is regression.
      // E.g., success rate: cand (0.8) - base (0.9) = -0.1 (regression of 0.1)
      
      const delta = candValue - baseValue;
      let absoluteDrop = 0;
      let relativeDrop = 0;

      // Note: We need a way to know if metric is "higher is better" or "lower is better".
      // For MVP, we assume passRate is "higher is better", latency is "lower is better".
      // We will infer based on the metric name or structure.
      const lowerIsBetter = rule.metric.includes('latency') || rule.metric.includes('error');
      
      if (lowerIsBetter) {
        // Latency: candidate (500) - baseline (400) = +100
        absoluteDrop = delta; 
        relativeDrop = baseValue !== 0 ? delta / baseValue : 0;
      } else {
        // Success rate: baseline (0.9) - candidate (0.8) = +0.1
        absoluteDrop = -delta;
        relativeDrop = baseValue !== 0 ? -delta / baseValue : 0;
      }

      let outcome: RegressionOutcome = 'PASS';
      let reason = 'No regression detected';

      if (rule.maxAbsoluteDropNum !== undefined && absoluteDrop > rule.maxAbsoluteDropNum) {
        outcome = 'FAIL';
        reason = `Absolute drop of ${absoluteDrop.toFixed(4)} exceeds allowed ${rule.maxAbsoluteDropNum}`;
      } else if (rule.maxRelativeDropPct !== undefined && relativeDrop > rule.maxRelativeDropPct) {
        outcome = 'FAIL';
        reason = `Relative drop of ${(relativeDrop * 100).toFixed(2)}% exceeds allowed ${(rule.maxRelativeDropPct * 100).toFixed(2)}%`;
      } else if (absoluteDrop > 0) {
        outcome = 'PASS';
        reason = 'Slight regression within allowed limits';
      } else if (absoluteDrop < 0) {
        outcome = 'PASS';
        reason = 'Improvement over baseline';
      }

      results.push({
        ruleId: rule.id,
        metric: rule.metric,
        baselineValue: baseValue,
        candidateValue: candValue,
        absoluteDelta: lowerIsBetter ? -absoluteDrop : -absoluteDrop, // standard delta: positive = improvement
        relativeDelta: relativeDrop,
        outcome,
        reason
      });
    }

    return results;
  }
}
