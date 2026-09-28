/**
 * Domain event bus.
 *
 * The port is deliberately tiny — publish, subscribe, unsubscribe — so that
 * swapping the in-process adapter for Redis, NATS or Kafka later is a matter of
 * writing one class, not rewriting call sites. ResearchOS ships the in-process
 * adapter because a single API process plus workers needs nothing more; adding
 * a broker before there are multiple processes to coordinate would be
 * infrastructure without a problem to solve.
 *
 * Durability is *not* this layer's job. Events are persisted by the event store
 * before they are published, so a dropped subscriber loses delivery, never
 * history — a client reconnects and replays from its last sequence number.
 */
import type { EventType, ResearchEvent } from "@research-os/contracts";

/**
 * The one logging capability this package needs.
 *
 * Declared structurally rather than imported from `@research-os/observability`
 * because both packages are layer 2 — cross-cutting peers — and a dependency
 * between them would make the layer an ordering problem instead of a set.
 * `Logger` satisfies this shape, so callers pass their real logger unchanged.
 */
export interface EventBusLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type EventHandler = (event: ResearchEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EventFilter {
  readonly projectId?: string;
  readonly types?: readonly EventType[];
}

export interface EventBus {
  publish(event: ResearchEvent): Promise<void>;
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe;
  /** Subscribers currently attached. Used by health checks and tests. */
  subscriberCount(): number;
}

interface Subscription {
  readonly filter: EventFilter;
  readonly handler: EventHandler;
}

export interface InMemoryEventBusOptions {
  readonly logger?: EventBusLogger;
  /**
   * Called when a handler throws. A failing subscriber must never fail the
   * publisher — a UI stream that breaks should not abort the research run
   * feeding it.
   */
  readonly onHandlerError?: (error: unknown, event: ResearchEvent) => void;
}

export class InMemoryEventBus implements EventBus {
  readonly #subscriptions = new Set<Subscription>();
  readonly #logger: EventBusLogger | undefined;
  readonly #onHandlerError: ((error: unknown, event: ResearchEvent) => void) | undefined;

  constructor(options: InMemoryEventBusOptions = {}) {
    this.#logger = options.logger;
    this.#onHandlerError = options.onHandlerError;
  }

  async publish(event: ResearchEvent): Promise<void> {
    const matching = [...this.#subscriptions].filter((subscription) => matches(subscription.filter, event));
    // Deliver concurrently but never let one subscriber's failure reject the
    // publish: allSettled, then report.
    //
    // The `async` on this callback is load-bearing, not decoration. A handler
    // may be synchronous (the type is `void | Promise<void>`), and a synchronous
    // handler that throws would throw inside `.map()` — before `allSettled`
    // exists to catch anything — taking the publisher down with it. Wrapping
    // each call in an async function turns that throw into a rejection the
    // aggregator can see. Removing it reintroduces the bug silently.
    const results = await Promise.allSettled(matching.map(async (subscription) => subscription.handler(event)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.#logger?.warn("Event handler failed", {
          eventType: event.type,
          projectId: event.projectId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        this.#onHandlerError?.(result.reason, event);
      }
    }
  }

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const subscription: Subscription = { filter, handler };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  subscriberCount(): number {
    return this.#subscriptions.size;
  }
}

export function matches(filter: EventFilter, event: ResearchEvent): boolean {
  if (filter.projectId && filter.projectId !== event.projectId) return false;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) return false;
  return true;
}

/** Records everything published. Used in tests to assert on emitted events. */
export class RecordingEventBus implements EventBus {
  readonly events: ResearchEvent[] = [];
  readonly #inner = new InMemoryEventBus();

  async publish(event: ResearchEvent): Promise<void> {
    this.events.push(event);
    await this.#inner.publish(event);
  }

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    return this.#inner.subscribe(filter, handler);
  }

  subscriberCount(): number {
    return this.#inner.subscriberCount();
  }

  ofType(type: EventType): ResearchEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  clear(): void {
    this.events.length = 0;
  }
}
