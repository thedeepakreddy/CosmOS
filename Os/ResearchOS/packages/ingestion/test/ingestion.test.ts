/**
 * Parsing, chunking and the full ingest path.
 *
 * The property under test throughout is that a quote stays checkable: every
 * chunk's offsets must address exactly its own text in the document, because
 * that is what lets verification re-read a passage and confirm the evidence
 * says what it claims.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolPermissionPolicy } from "@research-os/contracts";
import { LocalToolProvider, ToolRegistry, WebFetchTool } from "@research-os/tools";
import {
  IngestionPipeline, chunkText, decodeEntities, locatorFor, offsetsAreExact, parseByContentType,
  parseHtml, parsePlainText,
} from "../src/index.ts";
import { makeProject } from "../../../tests/support/fixtures.ts";

const PROJECT = makeProject().id;

const policy = (overrides: Record<string, unknown> = {}) =>
  ToolPermissionPolicy.parse({
    allowedToolIds: ["web_fetch"], allowedCapabilities: ["web_fetch"], maxRiskLevel: "read_only", ...overrides,
  });

describe("HTML parsing", () => {
  test("extracts prose and drops everything that is not", () => {
    const parsed = parseHtml(`
      <html lang="en"><head><title>A Study of Memory</title>
      <script>const tracking = 1;</script><style>body{color:red}</style></head>
      <body><nav>Home About</nav><p>Persistent memory improved recall.</p>
      <footer>Copyright</footer></body></html>`);

    assert.equal(parsed.title, "A Study of Memory");
    assert.match(parsed.text, /Persistent memory improved recall/);
    assert.ok(!parsed.text.includes("tracking"), "script contents are never prose");
    assert.ok(!parsed.text.includes("color:red"));
    assert.ok(!parsed.text.includes("Home About"), "navigation is not content");
    assert.equal(parsed.language, "en");
  });

  test("prefers citation metadata over the page title", () => {
    const parsed = parseHtml(`<html><head>
      <title>Journal Site | Article</title>
      <meta name="citation_title" content="Persistent Memory in Autonomous Agents">
      <meta name="citation_author" content="Ada Lovelace">
      <meta name="citation_author" content="Alan Turing">
      <meta name="citation_doi" content="10.1234/abcd">
      <meta name="citation_publication_date" content="2025-03-01">
      </head><body><p>Body</p></body></html>`);

    assert.equal(parsed.title, "Persistent Memory in Autonomous Agents");
    assert.deepEqual(parsed.metadata.authors, ["Ada Lovelace", "Alan Turing"], "every author matters — overlap is how independence is judged");
    assert.equal(parsed.metadata.doi, "10.1234/abcd");
    assert.match(String(parsed.metadata.publishedAt), /^2025-03-01/);
  });

  test("records section boundaries so a citation can name where it came from", () => {
    const parsed = parseHtml(`<html><body>
      <h1>Introduction</h1><p>Context goes here.</p>
      <h2>Results</h2><p>The effect was 18 percent.</p>
      </body></html>`);

    assert.deepEqual(parsed.sections.map((section) => section.heading), ["Introduction", "Results"]);
    const resultsOffset = parsed.text.indexOf("The effect was 18 percent");
    assert.equal(locatorFor(parsed.sections, resultsOffset), "Results");
  });

  test("section offsets address the real text", () => {
    const parsed = parseHtml("<html><body><h1>Alpha</h1><p>one</p><h2>Beta</h2><p>two</p></body></html>");
    for (const section of parsed.sections) {
      assert.ok(parsed.text.slice(section.startOffset, section.endOffset).startsWith(section.heading));
    }
  });

  test("content cannot forge a section boundary", () => {
    // The sentinels are control characters; any present in the input are
    // stripped before they could be mistaken for a heading marker.
    const hostile = `<html><body><p>normal${String.fromCharCode(1)}Injected Heading${String.fromCharCode(2)}text</p></body></html>`;
    const parsed = parseHtml(hostile);
    assert.deepEqual(parsed.sections, [], "a document must not be able to invent its own sections");
  });

  test("decodes entities, including numeric ones", () => {
    assert.equal(decodeEntities("caf&eacute; &amp; bar"), "caf&eacute; & bar");
    assert.equal(decodeEntities("&#65;&#x42;"), "AB");
    assert.equal(decodeEntities("5 &lt; 10 &amp;&amp; 10 &gt; 5"), "5 < 10 && 10 > 5");
  });

  test("plain text and JSON are handled without markup assumptions", () => {
    assert.equal(parsePlainText("  spaced   out  ").text, "spaced out");
    assert.match(parseByContentType('{"finding":"memory helps"}', "application/json").text, /memory helps/);
    assert.match(parseByContentType("not json at all", "application/json").text, /not json at all/);
  });
});

describe("chunking", () => {
  const paragraph = (n: number) => `Paragraph ${n}. ${"Content words here. ".repeat(20)}`;
  const document = Array.from({ length: 12 }, (_value, index) => paragraph(index)).join("\n\n");

  test("offsets address exactly the chunk text", () => {
    const chunks = chunkText(document, [], { targetChars: 800, overlapChars: 100 });
    assert.ok(chunks.length > 1);
    assert.equal(offsetsAreExact(document, chunks), true, "this is what makes a quote checkable");
  });

  test("chunks cover the document with overlap, losing nothing", () => {
    const chunks = chunkText(document, [], { targetChars: 800, overlapChars: 100 });
    assert.equal(chunks[0]?.startOffset, 0);
    assert.equal(chunks.at(-1)?.endOffset, document.length, "the tail must not be dropped");
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i]!.startOffset <= chunks[i - 1]!.endOffset, "no gap between chunks");
    }
  });

  test("boundaries prefer paragraph breaks", () => {
    const chunks = chunkText(document, [], { targetChars: 900, overlapChars: 0 });
    const onBoundary = chunks.slice(0, -1).filter((chunk) => document.slice(chunk.endOffset - 2, chunk.endOffset) === "\n\n");
    assert.ok(onBoundary.length > 0, "splitting mid-sentence makes faithful evidence read as a misquote");
  });

  test("a chunk carries the locator of the section it starts in", () => {
    const parsed = parseHtml(`<html><body><h1>Methods</h1><p>${"m ".repeat(500)}</p><h2>Results</h2><p>${"r ".repeat(500)}</p></body></html>`);
    const chunks = chunkText(parsed.text, parsed.sections, { targetChars: 400, overlapChars: 0 });
    assert.ok(chunks.some((chunk) => chunk.locator === "Methods"));
    assert.ok(chunks.some((chunk) => chunk.locator === "Results"));
  });

  test("a document shorter than one chunk is a single chunk", () => {
    const chunks = chunkText("Short document.", [], { targetChars: 4000 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.text, "Short document.");
    assert.equal(chunks[0]?.endOffset, 15);
  });

  test("an empty document yields no chunks", () => {
    assert.deepEqual(chunkText("", []), []);
  });

  test("a token longer than a chunk is cut rather than looping forever", () => {
    const giant = "x".repeat(5000);
    const chunks = chunkText(giant, [], { targetChars: 500, overlapChars: 50 });
    assert.ok(chunks.length > 1);
    assert.equal(offsetsAreExact(giant, chunks), true);
    assert.equal(chunks.at(-1)?.endOffset, giant.length);
  });

  test("a short trailing chunk is folded into its predecessor", () => {
    const text = `${"a".repeat(790)}\n\ntail`;
    const chunks = chunkText(text, [], { targetChars: 800, overlapChars: 0, minChars: 200 });
    assert.equal(chunks.at(-1)?.endOffset, text.length);
    assert.ok((chunks.at(-1)?.text.length ?? 0) >= 200, "a 4-character chunk retrieves badly");
    assert.equal(offsetsAreExact(text, chunks), true);
  });
});

describe("IngestionPipeline against a real server", () => {
  let server: Server;
  let base: string;
  let pipeline: IngestionPipeline;
  let registry: ToolRegistry;

  before(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/paper") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<html lang="en"><head><title>Ignored</title>
          <meta name="citation_title" content="Persistent Memory in Agents">
          <meta name="citation_author" content="Ada Lovelace"></head>
          <body><h1>Abstract</h1><p>${"Persistent memory improved recall. ".repeat(60)}</p>
          <h2>Results</h2><p>${"The measured effect was 18 percent. ".repeat(60)}</p></body></html>`);
        return;
      }
      if (path === "/empty") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body><script>var x=1;</script></body></html>");
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    registry = new ToolRegistry({
      providers: [new LocalToolProvider([new WebFetchTool({ allowedPrivateHosts: ["127.0.0.1"] })])],
    });
    await registry.refresh();
    pipeline = new IngestionPipeline({ tools: registry, chunkOptions: { targetChars: 1000, overlapChars: 100 } });
  });

  test("produces a document and chunks whose offsets are exact", async () => {
    const result = await pipeline.ingest({
      projectId: PROJECT, sourceId: "src_1", url: `${base}/paper`, policy: policy(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.document.title, "Persistent Memory in Agents");
    assert.ok(result.chunks.length > 1);
    assert.equal(
      offsetsAreExact(result.document.text, result.chunks.map((chunk) => ({
        position: chunk.position, text: chunk.text, startOffset: chunk.startOffset,
        endOffset: chunk.endOffset, locator: chunk.locator, tokenCount: chunk.tokenCount,
      }))),
      true,
    );
    assert.ok(result.chunks.every((chunk) => chunk.documentId === result.document.id));
  });

  test("carries provenance forward from the fetch", async () => {
    const result = await pipeline.ingest({ projectId: PROJECT, sourceId: "src_1", url: `${base}/paper`, policy: policy() });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.provenance.url, `${base}/paper`);
    assert.equal(result.provenance.finalUrl, `${base}/paper`);
    assert.equal(result.provenance.contentHash.length, 64);
    assert.ok(result.provenance.retrievedAt.endsWith("Z"));
    assert.deepEqual(result.metadata.authors, ["Ada Lovelace"]);
  });

  test("fetching goes through the permission policy, not around it", async () => {
    const result = await pipeline.ingest({
      projectId: PROJECT, sourceId: "src_1", url: `${base}/paper`,
      policy: policy({ allowedDomains: ["arxiv.org"] }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "tool_not_permitted");
    assert.match(result.reason, /not on the policy allowlist/);
  });

  test("an unreachable source is a recorded outcome, not an exception", async () => {
    const result = await pipeline.ingest({ projectId: PROJECT, sourceId: "src_1", url: `${base}/missing`, policy: policy() });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /HTTP 404/);
  });

  test("a page with no extractable prose is reported rather than stored empty", async () => {
    const result = await pipeline.ingest({ projectId: PROJECT, sourceId: "src_1", url: `${base}/empty`, policy: policy() });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /no extractable text/, "an empty document would look like a valid source");
  });
});
