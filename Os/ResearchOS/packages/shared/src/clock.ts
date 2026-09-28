/**
 * Time as a dependency.
 *
 * Every timestamp, timeout and lease expiry in ResearchOS reads from a Clock.
 * Injecting it is what makes the orchestrator's retry/lease/backoff logic
 * deterministically testable — the alternative is tests that sleep, which are
 * both slow and flaky.
 */

export interface Clock {
  now(): number;
  /** ISO-8601 string for the current instant. */
  isoNow(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * A clock whose time only moves when a test moves it. `sleep` resolves
 * immediately but records the requested delay, so backoff schedules can be
 * asserted exactly.
 */
export class TestClock implements Clock {
  #now: number;
  readonly sleeps: number[] = [];

  constructor(start: number | string = 0) {
    this.#now = typeof start === "string" ? Date.parse(start) : start;
  }

  now(): number {
    return this.#now;
  }

  isoNow(): string {
    return new Date(this.#now).toISOString();
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(value: number | string): void {
    this.#now = typeof value === "string" ? Date.parse(value) : value;
  }
}
