/**
 * Resumable event streams.
 *
 * Bridges the durable store and the live bus into one async iterable, which is
 * what an SSE or WebSocket endpoint consumes. The sequence in which those two
 * are combined is the whole trick and is easy to get wrong:
 *
 *   1. Subscribe to the live bus first, buffering anything that arrives.
 *   2. Replay history from the store.
 *   3. Emit buffered live events, discarding any whose sequence was already
 *      covered by the replay.
 *
 * Subscribing before replaying means an event published *during* the replay is
 * buffered rather than lost; de-duplicating by sequence afterwards means it is
 * not delivered twice. Replaying first and then subscribing would drop events
 * in that window — a silent gap that would be very hard to diagnose later.
 */
import type { ResearchEvent } from "@research-os/contracts";
import type { EventBus, EventFilter } from "./bus.ts";
import type { EventStore } from "./store.ts";

export interface StreamOptions extends EventFilter {
  readonly projectId: string;
  /** Resume point. Events with a sequence at or below this are not re-sent. */
  readonly since?: number;
  readonly signal?: AbortSignal;
  /** Replay page size. */
  readonly replayBatchSize?: number;
}

export async function* streamEvents(
  store: EventStore,
  bus: EventBus,
  options: StreamOptions,
): AsyncGenerator<ResearchEvent, void, undefined> {
  const { projectId, signal } = options;
  let lastDelivered = options.since ?? 0;

  const buffer: ResearchEvent[] = [];
  let notify: (() => void) | null = null;

  const unsubscribe = bus.subscribe(
    { projectId, ...(options.types ? { types: options.types } : {}) },
    (event) => {
      buffer.push(event);
      notify?.();
    },
  );

  try {
    // Phase 1: replay everything already persisted.
    const batchSize = options.replayBatchSize ?? 200;
    for (;;) {
      if (signal?.aborted) return;
      const batch = await store.read(projectId, {
        since: lastDelivered,
        limit: batchSize,
        ...(options.types ? { types: options.types } : {}),
      });
      if (batch.length === 0) break;
      for (const event of batch) {
        lastDelivered = Math.max(lastDelivered, event.sequence);
        yield event;
      }
      if (batch.length < batchSize) break;
    }

    // Phase 2: live tail, skipping anything the replay already covered.
    for (;;) {
      if (signal?.aborted) return;

      while (buffer.length > 0) {
        const event = buffer.shift();
        if (!event) continue;
        if (event.sequence <= lastDelivered) continue; // Already replayed.
        lastDelivered = event.sequence;
        yield event;
      }

      await new Promise<void>((resolve) => {
        notify = resolve;
        if (signal) {
          const onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        }
        // Wake periodically so an aborted stream is noticed even with no traffic.
        setTimeout(resolve, 15_000).unref?.();
      });
      notify = null;
    }
  } finally {
    unsubscribe();
  }
}

/** Formats an event as an SSE frame. `id` is the resume token the client echoes back. */
export function toServerSentEvent(event: ResearchEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify({ id: event.id, projectId: event.projectId, sequence: event.sequence, type: event.type, payload: event.payload, occurredAt: event.occurredAt, traceId: event.traceId })}`,
    "",
    "",
  ].join("\n");
}
