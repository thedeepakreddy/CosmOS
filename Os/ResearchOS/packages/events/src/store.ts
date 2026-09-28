/**
 * Event store port.
 *
 * Events are appended durably *before* being published, which is what makes the
 * stream resumable: a client that disconnects mid-run reconnects with the last
 * sequence number it saw and receives everything it missed. The sequence is
 * per-project and gapless, so "I have up to 41" is unambiguous.
 */
import type { EventType, ResearchEvent } from "@research-os/contracts";

export interface AppendEventInput {
  readonly projectId: string;
  readonly type: EventType;
  readonly payload: unknown;
  readonly traceId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface ReadEventsOptions {
  /** Exclusive lower bound. 0 returns from the beginning. */
  readonly since?: number;
  readonly limit?: number;
  readonly types?: readonly EventType[];
}

export interface EventStore {
  /** Assigns the next sequence number for the project and persists the event. */
  append(input: AppendEventInput): Promise<ResearchEvent>;
  read(projectId: string, options?: ReadEventsOptions): Promise<ResearchEvent[]>;
  lastSequence(projectId: string): Promise<number>;
}
