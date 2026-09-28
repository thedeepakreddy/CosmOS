import { EvaluationScore } from '../../contracts/Evaluator';
import { MetricAggregation } from '../../contracts/Domain';

export class AggregationEngine {
  aggregateScores(scores: EvaluationScore[]): MetricAggregation[] {
    const metricGroups: Record<string, EvaluationScore[]> = {};
    for (const score of scores) {
      if (!metricGroups[score.metric]) metricGroups[score.metric] = [];
      metricGroups[score.metric].push(score);
    }

    const aggregations: MetricAggregation[] = [];

    for (const [metric, metricScores] of Object.entries(metricGroups)) {
      const agg: MetricAggregation = { metric, count: metricScores.length };
      let sum = 0;
      let hasNum = false;
      let passCount = 0;
      let hasPass = false;
      let min = Infinity;
      let max = -Infinity;

      for (const score of metricScores) {
        if (typeof score.value === 'number') {
          hasNum = true;
          sum += score.value;
          if (score.value < min) min = score.value;
          if (score.value > max) max = score.value;
        }
        if (score.passed !== undefined) {
          hasPass = true;
          if (score.passed) passCount++;
        }
      }

      if (hasNum) {
        agg.sum = sum;
        agg.average = sum / metricScores.length;
        agg.min = min;
        agg.max = max;
      }
      
      if (hasPass) {
        agg.passCount = passCount;
        agg.passRate = passCount / metricScores.length;
      }

      aggregations.push(agg);
    }

    return aggregations;
  }
}
