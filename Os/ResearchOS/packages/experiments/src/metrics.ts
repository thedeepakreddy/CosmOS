/**
 * Reading results out of an experiment.
 *
 * An experiment's numbers have to cross a process boundary, and the options are
 * parsing prose or agreeing a format. Prose parsing would put a language model
 * between the measurement and the record, which is precisely where one must not
 * be: a metric is an observation, and an observation that was paraphrased is an
 * interpretation.
 *
 * So there is a marker line. Anything not on a marker line is stdout, not data.
 */

export const METRIC_MARKER = "RESEARCHOS_METRIC";

/**
 * Parses marker lines out of stdout.
 *
 *   RESEARCHOS_METRIC {"accuracy": 0.87, "f1": 0.83}
 *   RESEARCHOS_METRIC accuracy=0.87
 *
 * Later values win, so an experiment that refines a metric as it runs reports
 * its final figure. Non-finite values are dropped rather than recorded as NaN:
 * a metric that is not a number is not a measurement.
 */
export function parseMetrics(stdout: string): Record<string, number> {
  const metrics: Record<string, number> = {};

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(METRIC_MARKER)) continue;
    const payload = line.slice(METRIC_MARKER.length).trim();
    if (!payload) continue;

    if (payload.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // A malformed marker line is ignored, never guessed at.
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
      }
      continue;
    }

    const separator = payload.indexOf("=");
    if (separator <= 0) continue;
    const key = payload.slice(0, separator).trim();
    const value = Number(payload.slice(separator + 1).trim());
    if (key && Number.isFinite(value)) metrics[key] = value;
  }

  return metrics;
}

/** Formats a metric line, so an experiment template can emit one correctly. */
export function formatMetrics(metrics: Record<string, number>): string {
  return `${METRIC_MARKER} ${JSON.stringify(metrics)}`;
}
