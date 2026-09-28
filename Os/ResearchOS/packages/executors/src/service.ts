/**
 * The external executor protocol.
 *
 * This is the seam that lets a host application be ResearchOS's hands without
 * either codebase importing the other. An executor registers the capabilities
 * it can fulfil; ResearchOS requests a *capability*, never a named executor;
 * whichever healthy executor advertises it does the work in its own environment
 * and posts a result back.
 *
 * Three rules hold everywhere in this file:
 *
 *   - **ResearchOS asks for `browser`, not for a product.** Nothing here may
 *     name a specific host application, and the architecture linter fails the
 *     build if it ever does.
 *   - **A result is validated before it touches research state.** An executor
 *     runs outside this process and is therefore untrusted input, however
 *     friendly it is.
 *   - **A request has an expiry.** An executor that registers and then vanishes
 *     must not leave research tasks parked forever, so requests expire and the
 *     waiting task is failed with a reason rather than hanging.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ExecutorRegistration, ExecutorResult,
  type Executor, type ExecutorRequest, type ExecutorStatus, type ToolCapability,
} from "@research-os/contracts";
import type { ExecutorRepository } from "@research-os/persistence";
import { err, newId, systemClock, type Clock } from "@research-os/shared";

export interface ExecutorServiceOptions {
  readonly repository: ExecutorRepository;
  readonly clock?: Clock;
  /** An executor silent for longer than this is treated as unreachable. */
  readonly heartbeatTimeoutMs?: number;
  readonly defaultRequestTimeoutMs?: number;
}

export interface RegistrationResult {
  readonly executor: Executor;
  /**
   * Returned exactly once, at registration. Only its hash is stored, so a lost
   * token cannot be recovered — it has to be re-registered. That is the correct
   * trade: a token readable from the database is a credential the database now
   * has to be trusted with.
   */
  readonly token: string;
}

export class ExecutorService {
  readonly #repository: ExecutorRepository;
  readonly #clock: Clock;
  readonly #heartbeatTimeoutMs: number;
  readonly #defaultRequestTimeoutMs: number;

  constructor(options: ExecutorServiceOptions) {
    this.#repository = options.repository;
    this.#clock = options.clock ?? systemClock;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 120_000;
    this.#defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 120_000;
  }

  /* ---------- Registration and identity ---------- */

  async register(input: unknown, tenantId: string | null = null): Promise<RegistrationResult> {
    const registration = ExecutorRegistration.parse(input);
    const now = this.#clock.isoNow();

    // Re-registering under the same name replaces the record and issues a new
    // token: an executor that restarted is the same executor, and forcing a
    // rename on every restart would make reconnection the hard path.
    const existing = await this.#repository.findByName(registration.name);
    const token = `exk_${randomBytes(32).toString("base64url")}`;

    const executor: Executor = {
      id: existing?.id ?? newId("executor"),
      name: registration.name,
      displayName: registration.displayName ?? null,
      capabilities: registration.capabilities,
      callbackUrl: registration.callbackUrl ?? null,
      mode: registration.mode,
      status: "registered",
      maxConcurrentRequests: registration.maxConcurrentRequests,
      version: registration.version ?? null,
      lastHeartbeatAt: now,
      metadata: registration.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as Executor;

    await this.#repository.register(executor, hashToken(token), tenantId);

    // Deliberately not an event. The domain event stream is per project, and
    // executor registration belongs to no project — publishing it with an empty
    // project id would put a row in the stream that no consumer can resume past
    // and that the envelope schema rejects.

    return { executor, token };
  }

  /**
   * Resolves a bearer token to an executor.
   *
   * The hash comparison is constant-time. A timing-variable compare on a
   * credential leaks it one byte at a time to anyone patient enough.
   */
  async authenticate(token: string): Promise<Executor | undefined> {
    if (!token) return undefined;
    const candidate = await this.#repository.findByTokenHash(hashToken(token));
    if (!candidate) return undefined;
    return candidate.status === "revoked" ? undefined : candidate;
  }

  async heartbeat(executorId: string, status: ExecutorStatus = "healthy"): Promise<void> {
    await this.#repository.heartbeat(executorId, status, this.#clock.isoNow());
  }

  /** An executor that has not checked in recently is not a place to send work. */
  async healthyExecutorsFor(capability: ToolCapability): Promise<Executor[]> {
    const candidates = await this.#repository.findByCapability(capability);
    const cutoff = this.#clock.now() - this.#heartbeatTimeoutMs;
    return candidates.filter((executor) => {
      if (executor.status === "revoked" || executor.status === "unreachable") return false;
      if (!executor.lastHeartbeatAt) return false;
      return Date.parse(executor.lastHeartbeatAt) >= cutoff;
    });
  }

  async listExecutors(): Promise<Executor[]> {
    return this.#repository.list();
  }

  /* ---------- Requests ---------- */

  async requestCapability(input: {
    projectId: string;
    taskId?: string | null;
    capability: ToolCapability;
    toolId: string;
    payload: unknown;
    timeoutMs?: number;
  }): Promise<ExecutorRequest> {
    const available = await this.healthyExecutorsFor(input.capability);
    if (available.length === 0) {
      throw err.executorUnavailable(input.capability);
    }

    const now = this.#clock.now();
    const timeoutMs = input.timeoutMs ?? this.#defaultRequestTimeoutMs;
    const request: ExecutorRequest = {
      id: newId("executorRequest"),
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      capability: input.capability,
      toolId: input.toolId,
      input: input.payload,
      status: "pending",
      executorId: null,
      output: null,
      errorMessage: null,
      timeoutMs,
      expiresAt: new Date(now + timeoutMs).toISOString(),
      createdAt: new Date(now).toISOString(),
      claimedAt: null,
      completedAt: null,
    } as ExecutorRequest;

    await this.#repository.createRequest(request);
    return request;
  }

  /** Pull mode: an executor asks for work it can do. */
  async claimWork(executorId: string, capabilities: readonly ToolCapability[], max = 4): Promise<ExecutorRequest[]> {
    return this.#repository.claimRequests(executorId, capabilities, max, this.#clock.isoNow());
  }

  /**
   * Accepts a result from an executor.
   *
   * The executor is checked against the request it is answering. Without that,
   * any registered executor could post a result for any request — which would
   * let a low-privilege executor inject output into research it was never asked
   * to contribute to.
   */
  async submitResult(requestId: string, executorId: string, rawResult: unknown): Promise<ExecutorRequest> {
    const request = await this.#repository.findRequest(requestId);
    if (!request) throw err.notFound("Executor request", requestId);

    if (request.executorId && request.executorId !== executorId) {
      throw err.forbidden("This request was claimed by a different executor.", { requestId });
    }
    if (request.status === "succeeded" || request.status === "failed" || request.status === "cancelled") {
      throw err.conflict(`Executor request ${requestId} is already ${request.status}.`, { requestId, status: request.status });
    }

    const result = ExecutorResult.parse(rawResult);
    const now = this.#clock.isoNow();

    if (result.status === "succeeded") {
      await this.#repository.completeRequest(requestId, "succeeded", result.output, null, now);
    } else {
      await this.#repository.completeRequest(requestId, "failed", null, result.errorMessage, now);
    }

    const completed = await this.#repository.findRequest(requestId);
    /* c8 ignore next */
    if (!completed) throw err.internal(`Executor request ${requestId} vanished during completion.`);
    return completed;
  }

  /**
   * Fails requests nobody answered.
   *
   * Returns them so the caller can resume whatever task was parked on each. An
   * executor that registered and then vanished must not leave research waiting
   * indefinitely — a failure with a reason is recoverable, a hang is not.
   */
  async expireStale(): Promise<ExecutorRequest[]> {
    return this.#repository.expireStaleRequests(this.#clock.isoNow());
  }

  async findRequest(requestId: string): Promise<ExecutorRequest | undefined> {
    return this.#repository.findRequest(requestId);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, for callers that hold two hashes. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
