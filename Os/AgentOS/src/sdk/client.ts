import { AgentDefinition, AgentRun, Task } from '../domain/types';
import { AgentEvent } from '../domain/events';
import { TaskAttemptRecord } from '../persistence/contracts';

/**
 * Phase E: a typed error the caller can switch on.
 *
 * v0.1 threw `new Error(await res.text())`, so the only way to tell "run not
 * found" from "rate limited" was to parse a string.
 */
export class AgentOSError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly category?: string
  ) {
    super(message);
    this.name = 'AgentOSError';
  }
  get isNotFound(): boolean { return this.status === 404; }
  get isUnauthorized(): boolean { return this.status === 401; }
  get isRateLimited(): boolean { return this.status === 429; }
  get isConflict(): boolean { return this.status === 409; }
}

export interface AgentOSClientOptions {
  /** Bearer token, when the server has authentication enabled. */
  token?: string;
  fetch?: typeof fetch;
}

export interface TaskPage {
  tasks: Task[];
  nextCursor: string | null;
  total: number;
}

export class AgentOSClient {
  private readonly token?: string;
  private readonly doFetch: typeof fetch;

  constructor(private baseUrl: string, options: AgentOSClientOptions = {}) {
    this.token = options.token;
    this.doFetch = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await this.doFetch(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();

    if (!res.ok) {
      let code = 'UNKNOWN';
      let message = text || res.statusText;
      let category: string | undefined;
      try {
        const body = JSON.parse(text);
        if (body?.error?.code) {
          code = body.error.code;
          message = body.error.message ?? message;
          category = body.error.category;
        }
      } catch {
        /* non-JSON error body; keep the raw text as the message */
      }
      throw new AgentOSError(res.status, code, message, category);
    }

    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  // ---- agents --------------------------------------------------------------
  createAgent(agent: AgentDefinition): Promise<AgentDefinition> {
    return this.request('/v1/agents', { method: 'POST', body: JSON.stringify(agent) });
  }

  getAgent(id: string): Promise<AgentDefinition> {
    return this.request(`/v1/agents/${encodeURIComponent(id)}`);
  }

  // ---- runs ----------------------------------------------------------------
  createRun(run: Partial<AgentRun>): Promise<AgentRun> {
    return this.request('/v1/runs', { method: 'POST', body: JSON.stringify(run) });
  }

  getRun(runId: string): Promise<AgentRun> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  /** One page of a run's tasks. Task ids are unique within a run, not globally. */
  getTasks(runId: string, options: { limit?: number; cursor?: string } = {}): Promise<TaskPage> {
    const qs = new URLSearchParams();
    if (options.limit !== undefined) qs.set('limit', String(options.limit));
    if (options.cursor !== undefined) qs.set('cursor', options.cursor);
    const suffix = qs.toString() ? `?${qs}` : '';
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/tasks${suffix}`);
  }

  /** Every task in a run, following pagination to the end. */
  async getAllTasks(runId: string): Promise<Task[]> {
    const all: Task[] = [];
    let cursor: string | undefined;
    do {
      const page: TaskPage = await this.getTasks(runId, { cursor });
      all.push(...page.tasks);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }

  getTask(runId: string, taskId: string): Promise<Task> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`
    );
  }

  // ---- lifecycle -----------------------------------------------------------
  private lifecycle(runId: string, action: string): Promise<void> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
  }

  startRun(runId: string): Promise<void> { return this.lifecycle(runId, 'start'); }
  pauseRun(runId: string): Promise<void> { return this.lifecycle(runId, 'pause'); }
  /** Resume a PAUSED run. Not crash recovery -- see {@link recoverRun}. */
  resumeRun(runId: string): Promise<void> { return this.lifecycle(runId, 'resume'); }
  /** Adopt a run whose worker may have died; reclaims only expired leases. */
  recoverRun(runId: string): Promise<void> { return this.lifecycle(runId, 'recover'); }
  /** Phase E: previously absent from the SDK despite the route existing. */
  cancelRun(runId: string): Promise<void> { return this.lifecycle(runId, 'cancel'); }

  // ---- observability (Phase F) ---------------------------------------------

  /** Events for a run, ordered by sequence. `afterSeq` tails from a resume point. */
  getEvents(runId: string, afterSeq = 0): Promise<{ events: AgentEvent[]; lastSeq: number }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`);
  }

  /** Per-attempt history: what was tried, by whom, for how long, and why it ended. */
  getAttempts(runId: string, taskId?: string): Promise<{ attempts: TaskAttemptRecord[] }> {
    const qs = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/attempts${qs}`);
  }

  health(): Promise<{ status: string }> { return this.request('/health'); }

  /** Prometheus exposition for the worker that answers. */
  async metrics(): Promise<string> {
    const res = await this.doFetch(`${this.baseUrl}/metrics`);
    if (!res.ok) throw new AgentOSError(res.status, 'METRICS_UNAVAILABLE', res.statusText);
    return res.text();
  }
}
