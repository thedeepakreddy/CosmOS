import { z } from 'zod';

/**
 * Phase F: the event vocabulary, declared.
 *
 * The audit found the vocabulary itself well chosen, so it is preserved and
 * EXTENDED, not renamed. What was missing was a declaration: nothing said which
 * events exist or what their payloads contain, so "undeclared event" and
 * "invalid payload" were unmeasurable.
 *
 * Two corrections to existing semantics:
 *   - `run.created` is now actually emitted. The v0.1 schema comment advertised
 *     it and nothing ever produced it.
 *   - `run.paused` now fires when the run REACHES PAUSED. It previously fired on
 *     entry to PAUSING, so the event asserted something untrue while tasks were
 *     still running. Entry to PAUSING is now `run.pausing`.
 */

const base = {
  runId: z.string(),
  workerId: z.string().optional()
};

const taskBase = {
  ...base,
  taskId: z.string(),
  attempt: z.number().int().nonnegative(),
  fence: z.number().int().nonnegative()
};

/** Payload schema per event type. The keys ARE the vocabulary. */
export const EventPayloadSchemas = {
  'run.created':        z.object({ ...base, goal: z.string(), taskCount: z.number().int().nonnegative() }),
  'run.started':        z.object({ ...base }),
  'run.pausing':        z.object({ ...base }),
  'run.paused':         z.object({ ...base }),
  'run.resumed':        z.object({ ...base }),
  'run.recovering':     z.object({ ...base }),
  'run.completed':      z.object({ ...base, durationMs: z.number().int().nonnegative().optional() }),
  'run.failed':         z.object({ ...base, error: z.string(), tasksDrained: z.number().int().optional(), durationMs: z.number().int().nonnegative().optional() }),
  'run.cancelled':      z.object({ ...base, tasksDrained: z.number().int().optional(), durationMs: z.number().int().nonnegative().optional() }),

  'task.ready':         z.object({ ...base, taskId: z.string() }),
  'task.started':       z.object({ ...taskBase }),
  'task.succeeded':     z.object({ ...taskBase, durationMs: z.number().int().nonnegative() }),
  'task.failed':        z.object({ ...taskBase, error: z.string().optional(), durationMs: z.number().int().nonnegative().optional() }),
  'task.timed_out':     z.object({ ...taskBase, durationMs: z.number().int().nonnegative().optional() }),
  'task.cancelled':     z.object({ ...taskBase, durationMs: z.number().int().nonnegative().optional() }),
  'task.skipped':       z.object({ ...base, taskId: z.string() }),
  'task.retry.scheduled': z.object({ ...taskBase, retry: z.number().int().positive(), backoffMs: z.number().int().nonnegative(), error: z.string().optional() }),
  'task.result.discarded': z.object({ ...taskBase, reason: z.string() })
} as const;

export type EventType = keyof typeof EventPayloadSchemas;

export const EVENT_TYPES = Object.keys(EventPayloadSchemas) as EventType[];

export function isDeclaredEventType(type: string): type is EventType {
  return type in EventPayloadSchemas;
}

/** The full event envelope as persisted and streamed. */
export const AgentEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** Monotonic within a run, starting at 1. Gaps and duplicates are detectable. */
  seq: z.number().int().positive(),
  type: z.string(),
  timestamp: z.string().datetime(),
  /** The request or worker action that caused this event. */
  correlationId: z.string().optional(),
  /** The event that caused this one. */
  causationId: z.string().optional(),
  taskId: z.string().optional(),
  payload: z.unknown()
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export interface EventValidationIssue {
  seq: number;
  type: string;
  problem: string;
}

/**
 * Validate a stream of events: envelope shape, declared type, payload schema,
 * and sequence integrity (starts at 1, strictly increasing, no gaps, no repeats).
 */
export function validateEventStream(events: AgentEvent[]): EventValidationIssue[] {
  const issues: EventValidationIssue[] = [];
  let expected = 1;

  for (const event of events) {
    const envelope = AgentEventSchema.safeParse(event);
    if (!envelope.success) {
      issues.push({ seq: event.seq, type: event.type, problem: `invalid envelope: ${envelope.error.issues[0]?.message}` });
      continue;
    }
    if (!isDeclaredEventType(event.type)) {
      issues.push({ seq: event.seq, type: event.type, problem: 'undeclared event type' });
      continue;
    }
    const payload = EventPayloadSchemas[event.type].safeParse(event.payload);
    if (!payload.success) {
      issues.push({
        seq: event.seq, type: event.type,
        problem: `invalid payload: ${payload.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      });
    }
    if (event.seq !== expected) {
      issues.push({ seq: event.seq, type: event.type, problem: `sequence break: expected ${expected}` });
    }
    expected = event.seq + 1;
  }
  return issues;
}
