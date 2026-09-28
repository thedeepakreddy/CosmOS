/**
 * Tracing.
 *
 * One trace id spans an entire research run; spans nest beneath it for tasks,
 * agent runs, model calls and tool calls. This is what turns "the report is
 * wrong" into "the claim came from this evidence, extracted by this agent run,
 * which used this model call" without reading a transcript.
 */
import { newId, systemClock, type Clock, type SpanId, type TraceId } from "@research-os/shared";
import type { Logger } from "./logger.ts";

export const SPAN_KINDS = ["research_run", "task", "agent_run", "model_call", "tool_call", "executor_request", "experiment_run", "db_query"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export interface SpanRecord {
  readonly id: SpanId;
  readonly traceId: TraceId;
  readonly parentSpanId: SpanId | null;
  readonly kind: SpanKind;
  readonly name: string;
  readonly startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
  errorMessage: string | null;
}

export interface SpanSink {
  record(span: SpanRecord): void;
}

export class Span {
  readonly record: SpanRecord;
  readonly #tracer: Tracer;
  #ended = false;

  constructor(record: SpanRecord, tracer: Tracer) {
    this.record = record;
    this.#tracer = tracer;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.record.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, string | number | boolean | undefined>): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.record.attributes[key] = value;
    }
    return this;
  }

  /** Ends the span. Idempotent, so a `finally` block is always safe. */
  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.record.endedAt = this.#tracer.clock.now();
    this.record.durationMs = this.record.endedAt - this.record.startedAt;
    if (error !== undefined) {
      this.record.status = "error";
      this.record.errorMessage = error instanceof Error ? error.message : String(error);
    }
    this.#tracer.sink.record(this.record);
  }

  child(kind: SpanKind, name: string, attributes?: Record<string, string | number | boolean>): Span {
    return this.#tracer.startSpan(kind, name, { parent: this, ...(attributes ? { attributes } : {}) });
  }
}

export interface TracerOptions {
  readonly clock?: Clock;
  readonly sink?: SpanSink;
  readonly logger?: Logger;
}

export interface StartSpanOptions {
  readonly parent?: Span | null;
  readonly traceId?: TraceId;
  readonly attributes?: Record<string, string | number | boolean>;
}

export class Tracer {
  readonly clock: Clock;
  readonly sink: SpanSink;

  constructor(options: TracerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.sink = options.sink ?? { record: () => {} };
  }

  startSpan(kind: SpanKind, name: string, options: StartSpanOptions = {}): Span {
    const traceId = options.traceId ?? options.parent?.record.traceId ?? newId("trace");
    const record: SpanRecord = {
      id: newId("span"),
      traceId,
      parentSpanId: options.parent?.record.id ?? null,
      kind,
      name,
      startedAt: this.clock.now(),
      endedAt: null,
      durationMs: null,
      status: "ok",
      attributes: { ...options.attributes },
      errorMessage: null,
    };
    return new Span(record, this);
  }

  /** Runs `fn` inside a span, ending it correctly on both success and failure. */
  async withSpan<T>(kind: SpanKind, name: string, fn: (span: Span) => Promise<T>, options: StartSpanOptions = {}): Promise<T> {
    const span = this.startSpan(kind, name, options);
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (error) {
      span.end(error);
      throw error;
    }
  }
}

/** Collects spans in memory — used by tests and by the dev UI's trace view. */
export class MemorySpanSink implements SpanSink {
  readonly spans: SpanRecord[] = [];
  record(span: SpanRecord): void {
    this.spans.push(span);
  }
  byTrace(traceId: string): SpanRecord[] {
    return this.spans.filter((span) => span.traceId === traceId);
  }
  clear(): void {
    this.spans.length = 0;
  }
}
