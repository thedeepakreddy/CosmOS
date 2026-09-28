/**
 * Phase F: in-process metrics.
 *
 * The audit found no metrics at all. This is deliberately a small counter/gauge/
 * histogram registry rendered in Prometheus text format rather than a new
 * dependency -- AgentOS's dependency surface is worth keeping small, and the
 * exposition format is the part that matters for interoperability.
 *
 * Scope note: values are PER PROCESS. Behind N workers a scraper sees N series,
 * which is the normal Prometheus model, but any single response describes only
 * the worker that answered it.
 */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private help = new Map<string, string>();

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const rendered = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, '\\$1')}"`)
      .join(',');
    return `${name}{${rendered}}`;
  }

  describe(name: string, help: string): void { this.help.set(name, help); }

  increment(name: string, labels?: Record<string, string>, by = 1): void {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const k = this.key(name, labels);
    const series = this.histograms.get(k) ?? [];
    // Bounded: keep a recent window so memory cannot grow without limit.
    series.push(value);
    if (series.length > 1_000) series.shift();
    this.histograms.set(k, series);
  }

  percentile(name: string, p: number, labels?: Record<string, string>): number | undefined {
    const series = this.histograms.get(this.key(name, labels));
    if (!series || series.length === 0) return undefined;
    const sorted = [...series].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  getCounter(name: string, labels?: Record<string, string>): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    const baseName = (k: string) => k.split('{')[0];
    const emitted = new Set<string>();

    const header = (k: string, type: string) => {
      const n = baseName(k);
      if (emitted.has(n)) return;
      emitted.add(n);
      const h = this.help.get(n);
      if (h) lines.push(`# HELP ${n} ${h}`);
      lines.push(`# TYPE ${n} ${type}`);
    };

    for (const [k, v] of [...this.counters].sort()) { header(k, 'counter'); lines.push(`${k} ${v}`); }
    for (const [k, v] of [...this.gauges].sort()) { header(k, 'gauge'); lines.push(`${k} ${v}`); }
    for (const [k, series] of [...this.histograms].sort()) {
      const n = baseName(k);
      const suffix = k.slice(n.length);
      const withQuantile = (q: string) => (suffix ? `${suffix.slice(0, -1)},${q}}` : `{${q}}`);
      header(k, 'summary');
      const sorted = [...series].sort((a, b) => a - b);
      for (const q of [50, 95, 99]) {
        const value = sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))];
        lines.push(`${n}${withQuantile(`quantile="0.${q}"`)} ${value}`);
      }
      lines.push(`${n}_count${suffix} ${series.length}`);
      lines.push(`${n}_sum${suffix} ${series.reduce((a, b) => a + b, 0)}`);
    }
    return lines.join('\n') + '\n';
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

/** Process-wide registry. */
export const metrics = new Metrics();

metrics.describe('agentos_events_total', 'Events appended, by type.');
metrics.describe('agentos_task_attempts_total', 'Task execution attempts, by outcome.');
metrics.describe('agentos_task_duration_ms', 'Task execution duration in milliseconds.');
metrics.describe('agentos_runs_terminal_total', 'Runs reaching a terminal state, by state.');
metrics.describe('agentos_http_requests_total', 'HTTP requests, by method and status.');
metrics.describe('agentos_http_duration_ms', 'HTTP request duration in milliseconds.');
