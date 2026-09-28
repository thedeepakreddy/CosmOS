/**
 * Fetches a URL and returns its content with provenance attached.
 *
 * This is the tool most likely to be pointed at something hostile, because the
 * URL it is given frequently comes from a model that has just read a document
 * written by someone else. Three controls follow from that:
 *
 *   - **Redirects are followed manually, re-checking every hop.** `redirect:
 *     "follow"` would let `https://allowed.example/r` bounce to
 *     `http://169.254.169.254/` with the policy checked only on the first URL.
 *     This is the single most important line in the file.
 *   - **The body is read with a hard byte ceiling**, streamed rather than
 *     buffered whole, so a multi-gigabyte response cannot exhaust memory.
 *   - **Content is returned as data, never as instruction.** The output is a
 *     string field on a structured result; nothing here interprets it.
 */
import { ToolDescriptor } from "@research-os/contracts";
import { contentHash, err, normalizeWhitespace } from "@research-os/shared";
import { z } from "zod";
import { assertUrlAllowed } from "../permissions.ts";
import type { ResearchTool, ToolContext, ToolProvenance } from "../tool.ts";

export const WebFetchInput = z.object({
  url: z.string().min(1).max(2000),
  /** Truncation point for the returned text. The full byte count is reported. */
  maxCharacters: z.number().int().positive().max(2_000_000).default(200_000),
});
export type WebFetchInput = z.infer<typeof WebFetchInput>;

export interface WebFetchOutput {
  readonly url: string;
  /** Final URL after redirects. Differs from `url` when the content moved. */
  readonly finalUrl: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly provenance: ToolProvenance;
}

export interface WebFetchOptions {
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  /**
   * Private hosts this tool may reach, named one at a time. Empty by default.
   * See `UrlCheckOptions.allowedPrivateHosts`.
   */
  readonly allowedPrivateHosts?: readonly string[];
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript))/i;

export class WebFetchTool implements ResearchTool<WebFetchInput, WebFetchOutput> {
  readonly descriptor: ToolDescriptor;
  readonly inputSchema = WebFetchInput;

  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #urlCheck: { allowedPrivateHosts: readonly string[] };

  constructor(options: WebFetchOptions = {}) {
    this.#maxBytes = options.maxBytes ?? 5_000_000;
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#userAgent = options.userAgent ?? "ResearchOS/0.1 (+research-agent)";
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#urlCheck = { allowedPrivateHosts: options.allowedPrivateHosts ?? [] };

    this.descriptor = ToolDescriptor.parse({
      id: "web_fetch",
      name: "Fetch a web page",
      description:
        "Retrieves the contents of an HTTP(S) URL as text. Returns the content together with its source URL, " +
        "retrieval time and content hash, so anything derived from it stays traceable to where it came from.",
      capability: "web_fetch",
      riskLevel: "read_only",
      inputSchema: z.toJSONSchema(WebFetchInput) as Record<string, unknown>,
      provider: "local",
      cacheable: true,
      estimatedLatencyMs: 1500,
    });
  }

  async execute(input: WebFetchInput, context: ToolContext): Promise<WebFetchOutput> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(err.timeout(`web_fetch exceeded ${this.#timeoutMs}ms`)), this.#timeoutMs);

    try {
      let current = assertUrlAllowed(input.url, context.policy, this.descriptor.id, this.#urlCheck);
      let response: Response | undefined;

      for (let hop = 0; hop <= this.#maxRedirects; hop++) {
        response = await this.#fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": this.#userAgent, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
        });

        if (response.status < 300 || response.status >= 400) break;

        const location = response.headers.get("location");
        if (!location) break;
        if (hop === this.#maxRedirects) {
          throw err.tool(`web_fetch followed ${this.#maxRedirects} redirects without reaching content.`, { url: input.url });
        }
        // Every hop is re-checked against the policy and the private-address
        // rules. This is what makes the redirect chain safe rather than just
        // the first URL.
        current = assertUrlAllowed(new URL(location, current).toString(), context.policy, this.descriptor.id, this.#urlCheck);
      }

      /* c8 ignore next */
      if (!response) throw err.tool("web_fetch produced no response.", { url: input.url });

      if (!response.ok) {
        throw err.tool(`web_fetch received HTTP ${response.status} from ${current.toString()}`, {
          url: current.toString(),
          status: response.status,
        });
      }

      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      if (!TEXTUAL.test(contentType)) {
        throw err.unsupported(
          `web_fetch retrieves text; ${current.toString()} returned "${contentType}". Use a parser tool for binary formats.`,
          { url: current.toString(), contentType },
        );
      }

      const { text, bytes, truncated: overLimit } = await this.#readCapped(response);
      const normalised = normalizeWhitespace(text);
      const truncated = overLimit || normalised.length > input.maxCharacters;

      const provenance: ToolProvenance = {
        url: current.toString(),
        retrievedAt: this.#now(),
        statusCode: response.status,
        contentType,
        contentHash: contentHash(normalised),
        bytes,
      };

      return {
        url: input.url,
        finalUrl: current.toString(),
        content: normalised.slice(0, input.maxCharacters),
        truncated,
        provenance,
      };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Streams the body, stopping at the byte ceiling rather than buffering it all. */
  async #readCapped(response: Response): Promise<{ text: string; bytes: number; truncated: boolean }> {
    if (!response.body) {
      const text = await response.text();
      return { text, bytes: Buffer.byteLength(text), truncated: false };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parts: string[] = [];
    let bytes = 0;
    let truncated = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > this.#maxBytes) {
          truncated = true;
          const remaining = value.byteLength - (bytes - this.#maxBytes);
          parts.push(decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: false }));
          break;
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => { /* the body is already being discarded */ });
    }

    return { text: parts.join(""), bytes, truncated };
  }
}
