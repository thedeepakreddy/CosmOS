import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  AgentDefinitionSchema, AgentRunSchema, TaskSchema, AgentRun
} from '../domain/types';
import { Stores } from '../persistence/contracts';
import { Supervisor } from '../engine/Supervisor';
import { DAGValidator } from '../engine/DAGValidator';
import { Config } from '../config';
import { ApiError, badRequest, notFound, payloadTooLarge, toApiError } from './errors';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Phase E: request bodies are parsed by ZOD at runtime.
 *
 * The audit found zod never executed: schemas were converted to JSON Schema and
 * enforced by AJV *with coercion*, so `{"id": 1}` silently became `"1"` and the
 * string `"no"` became `["no"]`. The JSON Schema is still attached for OpenAPI
 * documentation, but zod is the authority, and AJV coercion is disabled in
 * server.ts.
 */
function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw badRequest('VALIDATION_FAILED', detail);
  }
  return result.data;
}

/** Task fields a client may supply. Ownership columns are not among them. */
const TaskInputSchema = TaskSchema.omit({
  runId: true, createdAt: true, startedAt: true, completedAt: true,
  output: true, error: true,
  ownerId: true, leaseExpiresAt: true, fence: true, attempt: true, notBefore: true
}).extend({ id: z.string().min(1).max(512) }).strict();

const CreateRunSchema = z.object({
  goal: z.string().min(1),
  budget: AgentRunSchema.shape.budget,
  taskGraph: z.object({
    tasks: z.array(TaskInputSchema),
    dependencies: z.array(z.object({ taskId: z.string(), dependsOn: z.string() }))
  }).optional()
}).strict();

const PageQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional()
});

const EventQuerySchema = z.object({
  /** Resume point for tailing: return only events after this sequence number. */
  afterSeq: z.coerce.number().int().nonnegative().optional()
});

const AttemptQuerySchema = z.object({ taskId: z.string().optional() });
const AgentVersionQuerySchema = z.object({ version: z.string().optional() });
const AgentSearchQuerySchema = z.object({ capabilities: z.string().optional() });

export function buildRoutes(
  fastify: FastifyInstance,
  supervisor: Supervisor,
  stores: Stores,
  config: Config
) {
  /** Wrap a handler so every thrown error goes through the sanitizing mapper. */
  const handler =
    (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          return await fn(req, reply);
        } catch (err) {
          const api = toApiError(err);
          if (api.status >= 500) {
            // The real error is logged here, with the request id, and never sent.
            req.log.error({ err, reqId: req.id }, 'unhandled error in route');
          }
          reply.status(api.status);
          return api.toBody();
        }
      };

  // ---- Agents --------------------------------------------------------------
  fastify.post('/v1/agents', {
    schema: { body: zodToJsonSchema(AgentDefinitionSchema) as any }
  }, handler(async (req) => {
    const agent = parseBody(AgentDefinitionSchema, req.body);
    stores.agents.save(agent);
    return agent;
  }));

  fastify.get('/v1/agents/:id', handler(async (req) => {
    const { id } = req.params as { id: string };
    // Phase G: `?version=` selects an exact version; omitting it returns the
    // newest. Versions coexist -- registering v2 no longer destroys v1.
    const { version } = parseBody(AgentVersionQuerySchema, req.query);
    const agent = stores.agents.get(id, version);
    if (!agent) throw notFound('AGENT_NOT_FOUND', 'Agent not found');
    return agent;
  }));

  fastify.get('/v1/agents/:id/versions', handler(async (req) => {
    const { id } = req.params as { id: string };
    const versions = stores.agents.listVersions(id);
    if (versions.length === 0) throw notFound('AGENT_NOT_FOUND', 'Agent not found');
    return { versions };
  }));

  /** Phase G: capability-based routing. `capabilities[]` was never read before. */
  fastify.get('/v1/agents', handler(async (req) => {
    const { capabilities } = parseBody(AgentSearchQuerySchema, req.query);
    const required = capabilities ? capabilities.split(',').map((c) => c.trim()).filter(Boolean) : [];
    return { agents: stores.agents.findByCapabilities(required) };
  }));

  // ---- Runs ----------------------------------------------------------------
  fastify.post('/v1/runs', {
    schema: { body: zodToJsonSchema(AgentRunSchema.omit({ id: true, createdAt: true, state: true })) as any }
  }, handler(async (req) => {
    const data = parseBody(CreateRunSchema, req.body);

    if (data.taskGraph && data.taskGraph.tasks.length > config.maxTasksPerRun) {
      throw payloadTooLarge(
        'GRAPH_TOO_LARGE',
        `Task graph has ${data.taskGraph.tasks.length} tasks; the limit is ${config.maxTasksPerRun}`
      );
    }

    const createdAt = new Date().toISOString();
    const run: AgentRun = {
      ...data,
      id: uuidv4(),
      state: 'CREATED',
      createdAt,
      taskGraph: data.taskGraph
        ? {
            // Ownership fields are not in TaskInputSchema, so they cannot arrive
            // from a client at all -- and TaskStore.upsert cannot write them either.
            tasks: data.taskGraph.tasks.map((t) => ({ ...t, runId: undefined as never, createdAt })),
            dependencies: data.taskGraph.dependencies
          }
        : undefined
    };

    if (run.taskGraph) {
      for (const t of run.taskGraph.tasks) t.runId = run.id;
      // A1 (Phase A, preserved): reject an invalid graph BEFORE persistence.
      DAGValidator.validate(run.taskGraph);
    }

    stores.runs.save(run);
    // Phase F: `run.created` is now actually emitted. The v0.1 schema comment
    // advertised it and nothing ever produced it, so the first thing that
    // happened to a run was invisible in telemetry.
    supervisor.recordRunCreated(
      run.id, run.goal, run.taskGraph?.tasks.length ?? 0, String(req.id)
    );
    return run;
  }));

  fastify.get('/v1/runs/:id', handler(async (req) => {
    const { id } = req.params as { id: string };
    const run = stores.runs.get(id);
    if (!run) throw notFound('RUN_NOT_FOUND', 'Run not found');
    return run;
  }));

  // ---- lifecycle: start / resume / recover are distinct operations (B9) -----
  const lifecycle = (
    path: string,
    status: string,
    op: (runId: string, correlationId: string) => Promise<void>
  ) => fastify.post(path, handler(async (req) => {
    // Phase F: the request id becomes the correlation id, so every event this
    // operation causes can be traced back to the request that caused it.
    await op((req.params as { id: string }).id, String(req.id));
    return { status };
  }));

  lifecycle('/v1/runs/:id/start', 'RUNNING', (id, c) => supervisor.startRun(id, c));
  lifecycle('/v1/runs/:id/pause', 'PAUSING', (id, c) => supervisor.pauseRun(id, c));
  lifecycle('/v1/runs/:id/resume', 'RUNNING', (id, c) => supervisor.resumeRun(id, c));
  lifecycle('/v1/runs/:id/recover', 'RECOVERING', (id, c) => supervisor.recoverRun(id, c));
  lifecycle('/v1/runs/:id/cancel', 'CANCELLED', (id, c) => supervisor.cancelRun(id, c));

  // ---- task lookup is always run-scoped (B21) ------------------------------
  fastify.get('/v1/runs/:id/tasks', handler(async (req) => {
    const { id } = req.params as { id: string };
    const query = parseBody(PageQuerySchema, req.query);

    // An unknown run is a 404, not an empty page. v0.1 returned 200 with `[]`,
    // making "no such run" indistinguishable from "a run with no tasks".
    if (!stores.runs.getMeta(id)) throw notFound('RUN_NOT_FOUND', 'Run not found');

    const limit = Math.min(query.limit ?? config.defaultPageSize, config.maxPageSize);
    const { tasks, nextCursor } = stores.tasks.pageByRun(id, limit, query.cursor);
    return { tasks, nextCursor, total: stores.tasks.countByRun(id) };
  }));

  fastify.get('/v1/runs/:runId/tasks/:taskId', handler(async (req) => {
    // There is deliberately no /v1/tasks/:taskId endpoint: a task id is only
    // meaningful inside its run, so every lookup carries run context.
    const { runId, taskId } = req.params as { runId: string; taskId: string };
    const task = stores.tasks.get({ runId, taskId });
    if (!task) throw notFound('TASK_NOT_FOUND', 'Task not found');
    return task;
  }));

  // ---- observability (Phase F) ---------------------------------------------
  // The audit's question was: "can an engineer understand why a run failed using
  // production telemetry alone?" These are the endpoints that make the answer yes.

  fastify.get('/v1/runs/:id/events', handler(async (req) => {
    const { id } = req.params as { id: string };
    const query = parseBody(EventQuerySchema, req.query);
    if (!stores.runs.getMeta(id)) throw notFound('RUN_NOT_FOUND', 'Run not found');
    const events = stores.events.listByRun(id, query.afterSeq ?? 0);
    return { events, lastSeq: events.length ? events[events.length - 1].seq : (query.afterSeq ?? 0) };
  }));

  fastify.get('/v1/runs/:id/instances', handler(async (req) => {
    const { id } = req.params as { id: string };
    if (!stores.runs.getMeta(id)) throw notFound('RUN_NOT_FOUND', 'Run not found');
    // Which agent definition VERSION actually ran, for which task, under which
    // worker, and how it ended. v0.1 recorded none of this.
    return { instances: stores.instances.listByRun(id) };
  }));

  fastify.get('/v1/runs/:id/usage', handler(async (req) => {
    const { id } = req.params as { id: string };
    if (!stores.runs.getMeta(id)) throw notFound('RUN_NOT_FOUND', 'Run not found');
    return { usage: stores.usage.get(id) };
  }));

  fastify.get('/v1/runs/:id/attempts', handler(async (req) => {
    const { id } = req.params as { id: string };
    const query = parseBody(AttemptQuerySchema, req.query);
    if (!stores.runs.getMeta(id)) throw notFound('RUN_NOT_FOUND', 'Run not found');
    // Per-attempt history: what was actually tried, by whom, for how long, and
    // why it ended. v0.1 kept none of this -- a retry overwrote the task row.
    return { attempts: stores.events.listAttempts(id, query.taskId) };
  }));

  /**
   * Server-sent events. The audit recorded streaming as acknowledged-missing;
   * it is a clean extension now that events carry a monotonic sequence, because
   * a reconnecting client resumes from `Last-Event-ID` with no gap and no replay.
   */
  fastify.get('/v1/runs/:id/events/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!stores.runs.getMeta(id)) {
      reply.status(404);
      return notFound('RUN_NOT_FOUND', 'Run not found').toBody();
    }

    const lastEventId = req.headers['last-event-id'];
    let cursor = typeof lastEventId === 'string' ? parseInt(lastEventId, 10) || 0 : 0;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const terminal = new Set(['run.completed', 'run.failed', 'run.cancelled']);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      reply.raw.end();
    };
    req.raw.on('close', finish);

    const pump = () => {
      if (closed) return;
      for (const event of stores.events.listByRun(id, cursor)) {
        cursor = event.seq;
        reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (terminal.has(event.type)) { finish(); return; }
      }
    };

    const poll = setInterval(pump, 100);
    pump();
    return reply;
  });

  // ---- catch-all: unknown routes and framework errors use the same envelope -
  fastify.setNotFoundHandler((req, reply) => {
    reply.status(404);
    return notFound('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.url}`).toBody();
  });

  fastify.setErrorHandler((err, req, reply) => {
    // Fastify's own errors (malformed JSON, body too large) reach here. They are
    // mapped into the same envelope so a client never sees two shapes.
    const status = (err as { statusCode?: number }).statusCode;
    const code = (err as { code?: string }).code;
    let api: ApiError;

    if (status === 413) {
      api = payloadTooLarge('BODY_TOO_LARGE', 'Request body is too large');
    } else if (code === 'FST_ERR_VALIDATION') {
      // AJV runs first (the JSON Schema is attached for OpenAPI docs) with
      // coercion disabled, so it rejects rather than silently converting types.
      // Report it as a validation failure, the same code zod produces, so a
      // client sees one consistent contract regardless of which layer caught it.
      api = badRequest('VALIDATION_FAILED', (err as Error).message);
    } else if (status === 400) {
      api = badRequest('MALFORMED_REQUEST', 'Request body could not be parsed');
    } else {
      api = toApiError(err);
    }

    if (api.status >= 500) req.log.error({ err, reqId: req.id }, 'unhandled framework error');
    reply.status(api.status);
    return api.toBody();
  });
}
