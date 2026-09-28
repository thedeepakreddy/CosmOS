/**
 * @research-os/retrieval — finding the passages that bear on a question.
 *
 * BM25 for exact terminology, embeddings for paraphrase, rank fusion to combine
 * them without inventing a conversion between their scales. Degrades to lexical
 * when no embedding provider is configured, and says so rather than quietly
 * returning worse answers.
 */
export * from "./bm25.ts";
export * from "./retriever.ts";
export * from "./embed.ts";
