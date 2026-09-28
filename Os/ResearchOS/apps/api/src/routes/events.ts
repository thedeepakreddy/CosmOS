/**
 * The event stream.
 *
 * Two ways to read the same history: a paged JSON endpoint for catching up, and
 * Server-Sent Events for following a run live. Both take a resume point, and
 * the resume point is a sequence number — which works only because the store
 * guarantees those are gapless per project.
 *
 * SSE rather than WebSocket because the traffic is one-directional and SSE
 * reconnects with `Last-Event-ID` on its own. A client that drops mid-run
 * resumes exactly where it was with no application code.
 */
import type { FastifyInstance } from "fastify";
import { EventsQuery } from "@research-os/contracts";
import { streamEvents, toServerSentEvent } from "@research-os/events";
import { err } from "@research-os/shared";
import { toLogError } from "@research-os/observability";
import type { AppContext } from "../app-context.ts";
import { parseQuery, sendError, traceIdOf } from "../http.ts";

export function registerEventRoutes(app: FastifyInstance, context: AppContext): void {
  const { store, bus, logger } = context;

  app.get("/api/v1/research/projects/:id/events", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = parseQuery(EventsQuery, request.query);
      if (!(await store.projects.findById(id))) throw err.notFound("Project", id);

      const events = await store.events.read(id, {
        since: query.since,
        limit: query.limit,
        ...(query.types.length > 0 ? { types: query.types as never } : {}),
      });
      return await reply.send({ items: events, lastSequence: events.at(-1)?.sequence ?? query.since });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/events/stream", async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!(await store.projects.findById(id))) {
      return sendError(reply, logger, err.notFound("Project", id), traceIdOf(request));
    }

    // `Last-Event-ID` is what a reconnecting EventSource sends automatically,
    // so honouring it is what makes reconnection lossless without the client
    // doing anything.
    const lastEventId = Number(request.headers["last-event-id"]);
    const query = parseQuery(EventsQuery, request.query);
    const since = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : query.since;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Proxies that buffer would defeat the point of streaming.
      "x-accel-buffering": "no",
    });

    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());

    // A comment frame every 20s keeps intermediaries from closing an idle
    // connection during a long-running research step.
    const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 20_000);
    keepAlive.unref?.();

    try {
      for await (const event of streamEvents(store.events, bus, {
        projectId: id,
        since,
        signal: controller.signal,
        ...(query.types.length > 0 ? { types: query.types as never } : {}),
      })) {
        if (controller.signal.aborted) break;
        reply.raw.write(toServerSentEvent(event));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn("Event stream ended with an error", { projectId: id, error: toLogError(error) });
      }
    } finally {
      clearInterval(keepAlive);
      reply.raw.end();
    }

    return reply;
  });
}
