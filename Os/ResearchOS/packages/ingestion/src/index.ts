/**
 * @research-os/ingestion — from a URL to citable spans.
 *
 * Fetching goes through the tool registry, so every ingest inherits the
 * permission policy, the domain rules and the call budget. Parsing keeps
 * offsets, and chunking preserves them, because a quote that cannot be located
 * in its source is not evidence.
 */
export * from "./parse.ts";
export * from "./chunk.ts";
export * from "./pipeline.ts";
