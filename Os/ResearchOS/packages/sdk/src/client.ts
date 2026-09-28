/**
 * The ResearchOS client.
 *
 * Types come from `@research-os/contracts`, which is the same definition the
 * server validates against — so a change to the API surface is a compile error
 * in every client rather than a runtime surprise in one of them.
 *
 * Errors arrive as `ResearchError` with the server's `code` preserved, so a
 * caller branches on a stable string instead of matching message text. The
 * `traceId` from the response is carried along, which is what makes a
 * client-side failure findable in server logs.
 */
import type {
  AddEvidenceRequest, AddEvidenceResponse, ApiErrorBody, Claim, ClaimDetailResponse, CreateProjectRequest,
  Evidence, HealthResponse, ListClaimsQuery, ListProjectsQuery, ProjectDetailResponse, ProjectResponse,
  ProjectStatusResponse, ResearchEvent, ResearchGraph, ResearchProject, ResearchReport, ResearchTree,
  RunProjectRequest, RunProjectResponse, Source, Task,
} from "@research-os/contracts";
import { ResearchError, type ErrorCode } from "@research-os/shared";

export interface ResearchOSClientOptions {
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`. Omit when the API is unauthenticated. */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Identifies the calling application; recorded on every project it creates. */
  readonly application?: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export class ResearchOSClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #application: string | undefined;

  constructor(options: ResearchOSClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#application = options.application;
  }

  /* ---------- Projects ---------- */

  async createProject(request: CreateProjectRequest): Promise<ResearchProject> {
    const body: CreateProjectRequest = this.#application
      ? { ...request, client: { application: this.#application, ...request.client } }
      : request;
    return (await this.#send<ProjectResponse>("POST", "/api/v1/research/projects", { body })).project;
  }

  async listProjects(query: Partial<ListProjectsQuery> = {}): Promise<Page<ResearchProject>> {
    return this.#send<Page<ResearchProject>>("GET", "/api/v1/research/projects", { query });
  }

  async getProject(projectId: string): Promise<ProjectDetailResponse> {
    return this.#send<ProjectDetailResponse>("GET", `/api/v1/research/projects/${projectId}`);
  }

  async getStatus(projectId: string): Promise<ProjectStatusResponse> {
    return this.#send<ProjectStatusResponse>("GET", `/api/v1/research/projects/${projectId}/status`);
  }

  async run(projectId: string, request: Partial<RunProjectRequest> = {}): Promise<RunProjectResponse> {
    return this.#send<RunProjectResponse>("POST", `/api/v1/research/projects/${projectId}/run`, { body: request });
  }

  async cancel(projectId: string, reason?: string): Promise<{ projectId: string; status: string; cancelledTasks: number }> {
    return this.#send("POST", `/api/v1/research/projects/${projectId}/cancel`, { body: reason ? { reason } : {} });
  }

  /* ---------- Artifacts ---------- */

  async listClaims(projectId: string, query: Partial<ListClaimsQuery> = {}): Promise<Page<Claim>> {
    return this.#send<Page<Claim>>("GET", `/api/v1/research/projects/${projectId}/claims`, { query });
  }

  async getClaim(projectId: string, claimId: string): Promise<ClaimDetailResponse & { provenance: { sources: { id: string; label: string }[]; evidenceCount: number; unsupported: boolean } }> {
    return this.#send("GET", `/api/v1/research/projects/${projectId}/claims/${claimId}`);
  }

  async listEvidence(projectId: string, query: { limit?: number; cursor?: string } = {}): Promise<Page<Evidence>> {
    return this.#send<Page<Evidence>>("GET", `/api/v1/research/projects/${projectId}/evidence`, { query });
  }

  async listSources(projectId: string, query: { limit?: number; cursor?: string } = {}): Promise<Page<Source>> {
    return this.#send<Page<Source>>("GET", `/api/v1/research/projects/${projectId}/sources`, { query });
  }

  async listTasks(projectId: string): Promise<Page<Task>> {
    return this.#send<Page<Task>>("GET", `/api/v1/research/projects/${projectId}/tasks`);
  }

  async getGraph(projectId: string): Promise<ResearchGraph> {
    return (await this.#send<{ graph: ResearchGraph }>("GET", `/api/v1/research/projects/${projectId}/graph`)).graph;
  }

  async getTree(projectId: string): Promise<ResearchTree> {
    return (await this.#send<{ tree: ResearchTree }>("GET", `/api/v1/research/projects/${projectId}/tree`)).tree;
  }

  async getReport(projectId: string, version?: number): Promise<ResearchReport> {
    return (await this.#send<{ report: ResearchReport }>(
      "GET",
      `/api/v1/research/projects/${projectId}/report`,
      version === undefined ? {} : { query: { version } },
    )).report;
  }

  /**
   * How well the research was conducted — not whether it is right.
   *
   * The response carries `caveats` stating exactly that, because a score that
   * looks like a quality rating will be read as one.
   */
  async getEvaluation(projectId: string): Promise<{
    overall: number;
    grade: "strong" | "adequate" | "weak" | "unsound";
    dimensions: { dimension: string; score: number; detail: string; applicable: boolean }[];
    weaknesses: string[];
    blockers: string[];
    summary: string;
    caveats: string[];
  }> {
    return (await this.#send<{ evaluation: never }>("GET", `/api/v1/research/projects/${projectId}/evaluation`)).evaluation;
  }

  async addEvidence(projectId: string, request: AddEvidenceRequest): Promise<AddEvidenceResponse> {
    return this.#send<AddEvidenceResponse>("POST", `/api/v1/research/projects/${projectId}/evidence`, { body: request });
  }

  /* ---------- Events ---------- */

  async getEvents(projectId: string, options: { since?: number; limit?: number } = {}): Promise<{ items: ResearchEvent[]; lastSequence: number }> {
    return this.#send("GET", `/api/v1/research/projects/${projectId}/events`, { query: options });
  }

  /**
   * Follows a run live.
   *
   * Resumes from `since`, so a caller that reconnects after a drop supplies the
   * last sequence it saw and loses nothing. The generator ends when the caller
   * aborts or the connection closes.
   */
  async *streamEvents(
    projectId: string,
    options: { since?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ResearchEvent, void, undefined> {
    const url = new URL(`${this.#baseUrl}/api/v1/research/projects/${projectId}/events/stream`);
    if (options.since) url.searchParams.set("since", String(options.since));

    const response = await this.#fetch(url, {
      headers: { ...this.#headers(), accept: "text/event-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new ResearchError({ code: "provider_error", message: `Event stream failed with HTTP ${response.status}.` });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a partial frame stays in
        // the buffer until the rest of it arrives.
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) {
            try {
              yield JSON.parse(data.slice(6)) as ResearchEvent;
            } catch {
              // A malformed frame is skipped rather than ending the stream:
              // losing one event is better than losing the rest of the run.
            }
          }
          separator = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => { /* the stream is already going away */ });
    }
  }

  /** Blocks until the run reaches a terminal state, or the timeout elapses. */
  async waitForCompletion(
    projectId: string,
    options: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ProjectStatusResponse> {
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    const interval = options.pollIntervalMs ?? 2000;
    const terminal = new Set(["completed", "failed", "cancelled"]);

    for (;;) {
      options.signal?.throwIfAborted();
      const status = await this.getStatus(projectId);
      if (terminal.has(status.status)) return status;
      if (Date.now() >= deadline) {
        throw new ResearchError({
          code: "timeout",
          message: `Project ${projectId} was still ${status.status} after the wait elapsed.`,
          details: { projectId, status: status.status },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /* ---------- Health ---------- */

  async health(): Promise<HealthResponse & { gaps: string[] }> {
    return this.#send("GET", "/health");
  }

  async capabilities(): Promise<{ taskTypes: string[]; tools: unknown[]; models: unknown[]; gaps: string[] }> {
    return this.#send("GET", "/api/v1/capabilities");
  }

  /* ---------- Transport ---------- */

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
    };
  }

  async #send<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, unknown> } = {},
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: this.#headers(),
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new ResearchError({
        code: controller.signal.aborted ? "timeout" : "provider_unavailable",
        message: controller.signal.aborted
          ? `${method} ${path} timed out after ${this.#timeoutMs}ms.`
          : `${method} ${path} could not reach the server.`,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const payload = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const body = payload as ApiErrorBody | undefined;
      // The server's own code is preserved rather than re-derived from the
      // status, so a caller can branch on exactly what went wrong.
      throw new ResearchError({
        code: (body?.error?.code as ErrorCode) ?? "provider_error",
        message: body?.error?.message ?? `${method} ${path} failed with HTTP ${response.status}.`,
        status: response.status,
        details: {
          ...(body?.error?.details ?? {}),
          ...(body?.error?.traceId ? { traceId: body.error.traceId } : {}),
        },
      });
    }

    return payload as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
