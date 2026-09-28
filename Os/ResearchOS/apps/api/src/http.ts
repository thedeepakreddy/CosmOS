/**
 * HTTP plumbing shared by every route.
 *
 * Three concerns live here so no route has to remember them:
 *
 *   - **Errors map to status codes through the error taxonomy**, not through
 *     per-route guesswork, so a `not_found` is a 404 everywhere and a client can
 *     branch on `code` rather than on message text.
 *   - **Request bodies are parsed through their contract schema.** The API's
 *     input surface and the SDK's types then come from one definition.
 *   - **Internal errors do not leak their internals.** The client gets a stable
 *     code and a trace id; the detail goes to the log.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorBody } from "@research-os/contracts";
import { err, isResearchError, toResearchError } from "@research-os/shared";
import { toLogError, type Logger } from "@research-os/observability";
import type { z } from "zod";

export function sendError(reply: FastifyReply, logger: Logger, thrown: unknown, traceId: string | null = null): FastifyReply {
  const error = toResearchError(thrown);

  // An unexpected throw is a bug, and its message may contain anything at all.
  // The client gets the code and the trace id; the detail stays in the log.
  const expected = isResearchError(thrown);
  if (!expected) logger.error("Unhandled error", { error: toLogError(thrown), traceId });

  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: expected ? error.message : "An internal error occurred.",
      ...(expected && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      traceId,
    },
  };
  return reply.status(error.status).send(body);
}

/** Parses a request body against its contract, turning a failure into a 400. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  throw err.validation(
    `Invalid request body: ${result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
  );
}

/** Same, for query strings, which arrive as strings and need coercion. */
export function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(coerceQuery(query));
  if (result.success) return result.data;
  throw err.validation(
    `Invalid query: ${result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
  );
}

/**
 * Query strings carry no types. Numbers and booleans are coerced so a schema
 * can declare what it actually wants rather than every field being a string.
 */
function coerceQuery(query: unknown): Record<string, unknown> {
  if (!query || typeof query !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value !== "string") { out[key] = value; continue; }
    if (value === "true") { out[key] = true; continue; }
    if (value === "false") { out[key] = false; continue; }
    if (value !== "" && !Number.isNaN(Number(value))) { out[key] = Number(value); continue; }
    if (key === "types" || key === "capabilities") { out[key] = value.split(",").filter(Boolean); continue; }
    out[key] = value;
  }
  return out;
}

/** The trace id for a request, used to tie a client-side failure to server logs. */
export function traceIdOf(request: FastifyRequest): string {
  return request.id;
}
