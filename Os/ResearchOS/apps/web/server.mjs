/**
 * The ResearchOS test UI: a static file server with an API proxy.
 *
 * Deliberately not a workspace and deliberately dependency-free. The UI is a
 * testing and demonstration surface, not part of the certified core: keeping it
 * outside `architecture.json`, outside `tsc -b` and outside the published
 * packages means it cannot change what ResearchOS is, and a mistake here cannot
 * reach the platform.
 *
 * **Why it proxies rather than calling the API cross-origin.** The SSE endpoint
 * writes its response headers with `reply.raw.writeHead()`, which bypasses
 * Fastify's CORS hook — so an event stream carries no `Access-Control-Allow-Origin`
 * even when `RESEARCH_OS_CORS_ORIGINS` is set, and a browser on another origin
 * cannot read it. Serving the API under the UI's own origin sidesteps that
 * entirely, needs no CORS configuration at all, and leaves the API untouched.
 *
 * The proxy streams both directions and never buffers, which is what keeps
 * server-sent events arriving as they are produced rather than at the end.
 */
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "public");
const PORT = Number(process.env.RESEARCH_OS_WEB_PORT ?? 5173);
const HOST = process.env.RESEARCH_OS_WEB_HOST ?? "127.0.0.1";
const API = new URL(process.env.RESEARCH_OS_API_URL ?? "http://127.0.0.1:8080");

/** Prefixes served by the API rather than from disk. */
const PROXIED = ["/api/", "/health"];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer((clientRequest, clientResponse) => {
  const path = (clientRequest.url ?? "/").split("?")[0];

  if (PROXIED.some((prefix) => path.startsWith(prefix))) {
    return proxy(clientRequest, clientResponse);
  }
  void serveStatic(path, clientResponse);
});

function proxy(clientRequest, clientResponse) {
  const upstream = httpRequest(
    {
      protocol: API.protocol,
      hostname: API.hostname,
      port: API.port,
      method: clientRequest.method,
      path: clientRequest.url,
      // `host` is rewritten so the API sees its own address; everything else —
      // authorization, accept, content-type — is passed through untouched.
      headers: { ...clientRequest.headers, host: API.host },
    },
    (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    },
  );

  upstream.on("error", (error) => {
    if (clientResponse.headersSent) return clientResponse.end();
    send(clientResponse, 502, "application/json; charset=utf-8", JSON.stringify({
      error: {
        code: "provider_unavailable",
        message: `The ResearchOS API at ${API.origin} could not be reached: ${error.message}`,
      },
    }));
  });

  /*
   * Client disconnect is watched on the *response*, not the request.
   *
   * `IncomingMessage` emits `close` as soon as the request stream is consumed,
   * which for a body-less GET is immediately — watching it there would destroy
   * every upstream request before it could answer. `ServerResponse` emits
   * `close` when the connection actually goes away, which is the real signal,
   * and it matters: SSE connections are long-lived, so a browser navigating
   * away must not leave an upstream stream open forever.
   */
  clientResponse.on("close", () => upstream.destroy());
  clientRequest.pipe(upstream);
}

async function serveStatic(path, response) {
  // The UI needs to know where the API is without being rebuilt, so it is told
  // at runtime rather than compiled in.
  if (path === "/config.json") {
    return send(response, 200, TYPES[".json"], JSON.stringify({ apiUrl: "", upstream: API.origin }));
  }

  const requested = path === "/" ? "/index.html" : path;

  // Path traversal: resolve, then confirm the result is still inside ROOT.
  // Checking the input for ".." instead would miss encoded and exotic forms.
  const target = resolve(join(ROOT, normalize(requested)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return send(response, 403, "text/plain; charset=utf-8", "Forbidden");
  }

  try {
    const body = await readFile(target);
    return send(response, 200, TYPES[extname(target)] ?? "application/octet-stream", body);
  } catch {
    return send(response, 404, "text/plain; charset=utf-8", "Not found");
  }
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

server.listen(PORT, HOST, () => {
  console.log(`ResearchOS test UI  →  http://${HOST}:${PORT}`);
  console.log(`proxying /api/* and /health  →  ${API.origin}`);
});
