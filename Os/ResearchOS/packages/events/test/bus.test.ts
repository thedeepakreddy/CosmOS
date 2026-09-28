/**
 * Event bus and stream behaviour.
 *
 * The properties under test here are the ones the rest of ResearchOS quietly
 * depends on: a subscriber can never break a publisher, filtering is exact, and
 * a stream resumed mid-run neither loses an event nor delivers one twice.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EventType, ResearchEvent } from "@research-os/contracts";
import { InMemoryEventBus, RecordingEventBus, matches, streamEvents, toServerSentEvent, type AppendEventInput, type EventStore, type ReadEventsOptions } from "../src/index.ts";
import { newId } from "@research-os/shared";

const PROJECT = newId("project");

function makeEvent(sequence: number, overrides: Partial<ResearchEvent> = {}): ResearchEvent {
  return {
    id: newId("event"),
    projectId: PROJECT,
    sequence,
    type: "research.claim.created" as EventType,
    payload: { n: sequence } as never,
    traceId: null,
    occurredAt: "2026-02-01T10:00:00.000Z",
    metadata: {},
    ...overrides,
  } as ResearchEvent;
}

/** Minimal in-memory EventStore, enough to drive the stream's replay phase. */
class FakeEventStore implements EventStore {
  readonly events: ResearchEvent[] = [];

  async append(input: AppendEventInput): Promise<ResearchEvent> {
    const event = makeEvent(this.events.length + 1, {
      projectId: input.projectId as ResearchEvent["projectId"],
      type: input.type,
      payload: input.payload as never,
    });
    this.events.push(event);
    return event;
  }

  async read(projectId: string, options: ReadEventsOptions = {}): Promise<ResearchEvent[]> {
    return this.events
      .filter((event) => event.projectId === projectId)
      .filter((event) => event.sequence > (options.since ?? 0))
      .filter((event) => !options.types?.length || options.types.includes(event.type))
      .slice(0, options.limit ?? 200);
  }

  async lastSequence(projectId: string): Promise<number> {
    return this.events.filter((event) => event.projectId === projectId).at(-1)?.sequence ?? 0;
  }
}

describe("InMemoryEventBus", () => {
  test("delivers to every matching subscriber", async () => {
    const bus = new InMemoryEventBus();
    const seen: number[] = [];
    bus.subscribe({ projectId: PROJECT }, (event) => { seen.push(event.sequence); });
    bus.subscribe({}, (event) => { seen.push(event.sequence * 100); });

    await bus.publish(makeEvent(1));

    assert.deepEqual(seen.sort((a, b) => a - b), [1, 100]);
    assert.equal(bus.subscriberCount(), 2);
  });

  test("a filter that does not match receives nothing", async () => {
    const bus = new InMemoryEventBus();
    let delivered = 0;
    bus.subscribe({ projectId: newId("project") }, () => { delivered++; });
    bus.subscribe({ types: ["research.started"] as EventType[] }, () => { delivered++; });

    await bus.publish(makeEvent(1, { type: "research.claim.created" as EventType }));
    assert.equal(delivered, 0);
  });

  test("unsubscribing stops delivery", async () => {
    const bus = new InMemoryEventBus();
    let delivered = 0;
    const unsubscribe = bus.subscribe({}, () => { delivered++; });

    await bus.publish(makeEvent(1));
    unsubscribe();
    await bus.publish(makeEvent(2));

    assert.equal(delivered, 1);
    assert.equal(bus.subscriberCount(), 0);
  });

  test("an async handler that rejects does not fail the publisher", async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus({ onHandlerError: (error) => errors.push(error) });
    let healthyDelivered = 0;

    bus.subscribe({}, async () => { throw new Error("async subscriber exploded"); });
    bus.subscribe({}, () => { healthyDelivered++; });

    await assert.doesNotReject(bus.publish(makeEvent(1)));
    assert.equal(healthyDelivered, 1, "a healthy subscriber still receives the event");
    assert.equal(errors.length, 1);
  });

  test("a SYNCHRONOUS handler that throws does not fail the publisher", async () => {
    // The dangerous case: a handler that throws before returning a promise
    // throws while the delivery list is still being built, so it can escape the
    // aggregator entirely. A UI stream that breaks must never abort the
    // research run feeding it.
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus({ onHandlerError: (error) => errors.push(error) });
    let healthyDelivered = 0;

    bus.subscribe({}, () => { throw new Error("sync subscriber exploded"); });
    bus.subscribe({}, () => { healthyDelivered++; });

    await assert.doesNotReject(bus.publish(makeEvent(1)));
    assert.equal(healthyDelivered, 1, "the healthy subscriber must still be delivered to");
    assert.equal(errors.length, 1, "and the failure must still be reported");
    assert.match(String((errors[0] as Error).message), /sync subscriber exploded/);
  });

  test("a failing handler is reported to the logger as well", async () => {
    const warnings: string[] = [];
    const bus = new InMemoryEventBus({ logger: { warn: (message) => warnings.push(message) } });
    bus.subscribe({}, () => { throw new Error("boom"); });

    await bus.publish(makeEvent(1));
    assert.deepEqual(warnings, ["Event handler failed"]);
  });
});

describe("matches", () => {
  const event = makeEvent(1, { type: "research.started" as EventType });

  test("an empty filter matches everything", () => {
    assert.equal(matches({}, event), true);
  });

  test("project and type are both required when given", () => {
    assert.equal(matches({ projectId: PROJECT }, event), true);
    assert.equal(matches({ projectId: newId("project") }, event), false);
    assert.equal(matches({ types: ["research.started"] as EventType[] }, event), true);
    assert.equal(matches({ types: ["research.completed"] as EventType[] }, event), false);
    assert.equal(matches({ projectId: PROJECT, types: ["research.completed"] as EventType[] }, event), false);
  });

  test("an empty type list is not a filter", () => {
    assert.equal(matches({ types: [] }, event), true);
  });
});

describe("RecordingEventBus", () => {
  test("records what it publishes and still delivers", async () => {
    const bus = new RecordingEventBus();
    let delivered = 0;
    bus.subscribe({}, () => { delivered++; });

    await bus.publish(makeEvent(1, { type: "research.started" as EventType }));
    await bus.publish(makeEvent(2, { type: "research.claim.created" as EventType }));

    assert.equal(bus.events.length, 2);
    assert.equal(delivered, 2);
    assert.equal(bus.ofType("research.started" as EventType).length, 1);

    bus.clear();
    assert.equal(bus.events.length, 0);
  });
});

describe("streamEvents", () => {
  test("replays history, then tails live events without gap or duplicate", async () => {
    const store = new FakeEventStore();
    const bus = new InMemoryEventBus();
    for (let i = 0; i < 3; i++) await store.append({ projectId: PROJECT, type: "research.claim.created" as EventType, payload: {} });

    const controller = new AbortController();
    const received: number[] = [];
    const stream = streamEvents(store, bus, { projectId: PROJECT, signal: controller.signal, replayBatchSize: 2 });

    const consumer = (async () => {
      for await (const event of stream) {
        received.push(event.sequence);
        if (received.length === 5) { controller.abort(); break; }
      }
    })();

    // Give the replay phase a turn, then publish live.
    await new Promise((resolve) => setImmediate(resolve));
    await bus.publish(makeEvent(4));
    await bus.publish(makeEvent(5));
    await consumer;

    assert.deepEqual(received, [1, 2, 3, 4, 5], "history then live, in order, exactly once each");
  });

  test("resuming from a sequence does not re-send what the client already has", async () => {
    const store = new FakeEventStore();
    const bus = new InMemoryEventBus();
    for (let i = 0; i < 5; i++) await store.append({ projectId: PROJECT, type: "research.claim.created" as EventType, payload: {} });

    const controller = new AbortController();
    const received: number[] = [];
    const stream = streamEvents(store, bus, { projectId: PROJECT, since: 3, signal: controller.signal });

    for await (const event of stream) {
      received.push(event.sequence);
      if (received.length === 2) { controller.abort(); break; }
    }

    assert.deepEqual(received, [4, 5], "resume is exclusive of the sequence the client reports");
  });

  test("an event published during replay is buffered, not lost", async () => {
    const store = new FakeEventStore();
    const bus = new InMemoryEventBus();
    await store.append({ projectId: PROJECT, type: "research.started" as EventType, payload: {} });

    const controller = new AbortController();
    const received: number[] = [];
    const stream = streamEvents(store, bus, { projectId: PROJECT, signal: controller.signal });

    // Publish before the consumer ever pulls: the subscription is created when
    // the generator body first runs, so this exercises the buffering path.
    const consumer = (async () => {
      for await (const event of stream) {
        received.push(event.sequence);
        if (received.length === 2) { controller.abort(); break; }
      }
    })();

    await new Promise((resolve) => setImmediate(resolve));
    await bus.publish(makeEvent(2));
    await consumer;

    assert.deepEqual(received, [1, 2]);
  });
});

describe("toServerSentEvent", () => {
  test("emits a frame whose id is the resume token", () => {
    const frame = toServerSentEvent(makeEvent(42, { type: "research.completed" as EventType }));
    const lines = frame.split("\n");

    assert.equal(lines[0], "id: 42", "the SSE id is the sequence, which is what the client echoes back");
    assert.equal(lines[1], "event: research.completed");
    assert.ok(lines[2]?.startsWith("data: "));
    assert.ok(frame.endsWith("\n\n"), "a frame must be terminated by a blank line");

    const data = JSON.parse(lines[2]!.slice("data: ".length)) as Record<string, unknown>;
    assert.equal(data["sequence"], 42);
    assert.equal(data["type"], "research.completed");
    assert.equal(data["projectId"], PROJECT);
    assert.equal("metadata" in data, false, "internal metadata is not part of the wire format");
  });

  test("the data payload is a single line, so a multi-line payload cannot break framing", () => {
    const frame = toServerSentEvent(makeEvent(1, { payload: { text: "line one\nline two" } as never }));
    const dataLines = frame.split("\n").filter((line) => line.startsWith("data: "));
    assert.equal(dataLines.length, 1);
  });
});
