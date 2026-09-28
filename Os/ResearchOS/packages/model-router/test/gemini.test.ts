/**
 * The Gemini adapter.
 *
 * An adapter's job is translation, so these tests are about the translations
 * that would be invisible if they were wrong: a blocked response that reads as
 * an empty one, a rate limit classified as permanent, a credential in a URL.
 * The network is stubbed — `fetchImpl` exists for exactly this — so every
 * mapping is asserted without a key and without a call leaving the machine.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TestClock, type ResearchError } from "@research-os/shared";
import { GEMINI_MODEL_SPECS, GeminiProvider, geminiProviderFromEnv } from "../src/index.ts";

const PRICING = Object.fromEntries(
  GEMINI_MODEL_SPECS.map((spec) => [spec.id, { inputCostPerMTokUsd: 2, outputCostPerMTokUsd: 10 }]),
);

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** A stub `fetch` that records what it was asked to send and replays one answer. */
function stubFetch(response: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof response === "string" ? response : JSON.stringify(response)),
    };
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function makeProvider(response: unknown, status = 200) {
  const { fetch, calls } = stubFetch(response, status);
  const provider = new GeminiProvider({
    apiKey: "test-key", pricing: PRICING, fetchImpl: fetch, clock: new TestClock(),
  });
  return { provider, calls };
}

const ANSWER = {
  candidates: [{ content: { parts: [{ text: "hello" }], role: "model" }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
};

describe("GeminiProvider — construction", () => {
  test("an absent key is refused, naming the variable to set", () => {
    assert.throws(
      () => new GeminiProvider({ apiKey: "", pricing: PRICING }),
      (error: ResearchError) => error.code === "validation_failed" && /GEMINI_API_KEY/.test(error.message),
    );
  });

  test("a model with no configured price is refused at construction", () => {
    assert.throws(
      () => new GeminiProvider({ apiKey: "k", pricing: {} }),
      (error: ResearchError) => error.code === "validation_failed" && /RESEARCH_OS_MODEL_PRICING/.test(error.message),
      "billing at zero would silently corrupt every budget decision",
    );
  });

  test("the catalog offers an embedding model, which the Anthropic catalog does not", () => {
    const provider = new GeminiProvider({ apiKey: "k", pricing: PRICING });
    const embedding = provider.models.filter((model) => model.capabilities.includes("embedding"));
    assert.equal(embedding.length, 1);
    assert.equal(embedding[0]?.id, "gemini-embedding-001");
  });
});

describe("GeminiProvider — request shape", () => {
  test("the assistant role is translated to Gemini's name for it", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({
      model: "gemini-flash-latest",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });
    const contents = calls[0]?.body["contents"] as { role: string }[];
    assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  });

  test("the system prompt travels as systemInstruction, not as a message", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({
      model: "gemini-flash-latest", system: "be careful", messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(calls[0]?.body["systemInstruction"], { parts: [{ text: "be careful" }] });
    assert.equal((calls[0]?.body["contents"] as unknown[]).length, 1, "the system prompt must not also appear as a turn");
  });

  test("the API key is sent in a header and never in the URL", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "test-key");
    assert.ok(
      !calls[0]?.url.includes("test-key"),
      "a URL reaches proxy logs, browser history and error reports; a credential must not",
    );
  });

  test("the output ceiling is clamped to what the model actually supports", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({
      model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10_000_000,
    });
    const config = calls[0]?.body["generationConfig"] as { maxOutputTokens: number };
    assert.equal(config.maxOutputTokens, 65_536);
  });

  test("a JSON schema asks for native structured output", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({
      model: "gemini-flash-latest",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: { type: "object", properties: { a: { type: "string" } } },
    });
    const config = calls[0]?.body["generationConfig"] as Record<string, unknown>;
    assert.equal(config["responseMimeType"], "application/json");
    assert.deepEqual(config["responseSchema"], { type: "object", properties: { a: { type: "string" } } });
  });

  test("an unknown model is refused before any request is made", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await assert.rejects(
      provider.generate({ model: "gemini-9-imaginary", messages: [{ role: "user", content: "hi" }] }),
      (error: ResearchError) => error.code === "validation_failed",
    );
    assert.equal(calls.length, 0);
  });
});

/*
 * Gemini's `responseSchema` is a narrower dialect than JSON Schema, and it
 * rejects the whole request rather than ignoring what it does not understand.
 * Measured against the live API: a schema carrying `minimum` or `maxLength`
 * returns 400 INVALID_ARGUMENT, while the same schema without them is accepted
 * and answers in the right shape. Dropping those costs nothing that matters —
 * they constrain decoding only, and `structured()` still validates the result
 * against the real zod schema, which is what actually enforces them.
 */
describe("GeminiProvider — schema narrowing", () => {
  const richSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      priority: { type: "integer", minimum: 0, maximum: 100 },
      objectives: {
        type: "array", minItems: 1, maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { statement: { type: "string", minLength: 1, maxLength: 2000 } },
          required: ["statement"],
        },
      },
    },
    required: ["priority", "objectives"],
  };

  const sentSchema = async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({
      model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }], jsonSchema: richSchema,
    });
    const config = calls[0]?.body["generationConfig"] as Record<string, unknown>;
    return config["responseSchema"] as Record<string, unknown>;
  };

  test("keywords Gemini rejects are stripped at every depth", async () => {
    const sent = await sentSchema();
    const keys = new Set<string>();
    (function walk(value: unknown): void {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) { keys.add(key); walk(child); }
    })(sent);

    for (const rejected of ["$schema", "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
      assert.ok(!keys.has(rejected), `"${rejected}" reaches Gemini and makes it 400 the entire request`);
    }
  });

  test("the structural shape survives, or the schema would be pointless", async () => {
    const sent = await sentSchema();
    const properties = sent["properties"] as Record<string, Record<string, unknown>>;
    assert.equal(sent["type"], "object");
    assert.deepEqual(sent["required"], ["priority", "objectives"]);
    assert.equal(properties["objectives"]?.["type"], "array");
    const items = properties["objectives"]?.["items"] as Record<string, Record<string, unknown>>;
    assert.ok(items["properties"]?.["statement"], "the nested shape is the whole point of sending a schema");
    assert.deepEqual(items["required"], ["statement"]);
  });

  test("a schema also switches the response to JSON", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }], jsonSchema: richSchema });
    const config = calls[0]?.body["generationConfig"] as Record<string, unknown>;
    assert.equal(config["responseMimeType"], "application/json");
  });

  test("no schema means no responseSchema and no forced JSON", async () => {
    const { provider, calls } = makeProvider(ANSWER);
    await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    const config = calls[0]?.body["generationConfig"] as Record<string, unknown>;
    assert.equal(config["responseSchema"], undefined);
    assert.equal(config["responseMimeType"], undefined);
  });
});

describe("GeminiProvider — response mapping", () => {
  test("text, usage and cost come back on the contract's shape", async () => {
    const { provider } = makeProvider(ANSWER);
    const response = await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.text, "hello");
    assert.equal(response.provider, "gemini");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(response.usage.inputTokens, 1000);
    assert.equal(response.usage.outputTokens, 200);
    // 1000/1e6*2 + 200/1e6*10 = 0.002 + 0.002
    assert.equal(response.usage.costUsd, 0.004);
  });

  test("a truncated answer is reported as truncated", async () => {
    const { provider } = makeProvider({
      candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const response = await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.stopReason, "max_tokens");
  });

  test("a safety stop is a refusal, not a completed answer", async () => {
    const { provider } = makeProvider({
      candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
    });
    const response = await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.stopReason, "refusal", "reporting end_turn would present a blocked reply as a complete one");
    assert.equal(response.refusalCategory, "SAFETY");
  });

  test("a prompt blocked before generation is a refusal, not an empty success", async () => {
    const { provider } = makeProvider({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } });
    const response = await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.text, "");
    assert.equal(response.stopReason, "refusal");
    assert.equal(response.refusalCategory, "PROHIBITED_CONTENT");
  });

  test("function calls are mapped, with an id synthesised because Gemini issues none", async () => {
    const { provider } = makeProvider({
      candidates: [{
        content: { parts: [{ text: "using a tool" }, { functionCall: { name: "search", args: { q: "x" } } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const response = await provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "search");
    assert.deepEqual(response.toolCalls[0]?.input, { q: "x" });
    assert.ok(response.toolCalls[0]?.id, "the rest of ResearchOS correlates a call with its result by id");
  });
});

describe("GeminiProvider — failure classification", () => {
  const cases: [number, boolean, RegExp][] = [
    [401, false, /rejected the credentials/],
    [403, false, /rejected the credentials/],
    [400, false, /rejected the request/],
    [404, false, /rejected the request/],
    [429, true, /temporarily unavailable/],
    [500, true, /temporarily unavailable/],
    [503, true, /temporarily unavailable/],
  ];

  for (const [status, retryable, pattern] of cases) {
    test(`HTTP ${status} is ${retryable ? "retryable" : "final"}`, async () => {
      const { provider } = makeProvider({ error: { message: "upstream said so" } }, status);
      await assert.rejects(
        provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] }),
        (error: ResearchError) => {
          assert.equal(error.retryable, retryable, `HTTP ${status} retryable should be ${retryable}`);
          assert.match(error.message, pattern);
          return true;
        },
      );
    });
  }

  test("the provider's own message is preserved, not replaced with a generic one", async () => {
    const { provider } = makeProvider({ error: { message: "API key not valid. Please pass a valid API key." } }, 400);
    await assert.rejects(
      provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] }),
      (error: ResearchError) => /API key not valid/.test(error.message),
    );
  });

  test("a non-JSON error body still reaches the operator", async () => {
    const { provider } = makeProvider("<html>502 Bad Gateway</html>", 502);
    await assert.rejects(
      provider.generate({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] }),
      (error: ResearchError) => /Bad Gateway/.test(error.message) && error.retryable,
    );
  });
});

describe("GeminiProvider — embeddings", () => {
  test("vectors and their dimensions come back", async () => {
    const { provider } = makeProvider({ embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }] });
    const response = await provider.embed({ model: "gemini-embedding-001", inputs: ["a", "b"] });
    assert.equal(response.vectors.length, 2);
    assert.equal(response.dimensions, 3);
    assert.equal(response.provider, "gemini");
  });

  test("a generative model is refused as an embedding model", async () => {
    const { provider } = makeProvider({});
    await assert.rejects(
      provider.embed({ model: "gemini-flash-latest", inputs: ["a"] }),
      (error: ResearchError) => error.code === "validation_failed" && /not an embedding model/.test(error.message),
    );
  });

  test("an empty embedding response fails rather than returning nothing useful", async () => {
    const { provider } = makeProvider({ embeddings: [] });
    await assert.rejects(
      provider.embed({ model: "gemini-embedding-001", inputs: ["a"] }),
      (error: ResearchError) => error.code === "provider_error",
    );
  });
});

describe("geminiProviderFromEnv", () => {
  test("no key means no provider, which is a valid configuration rather than an error", () => {
    assert.equal(geminiProviderFromEnv({}), undefined);
  });

  test("GOOGLE_API_KEY is accepted as a fallback", () => {
    const provider = geminiProviderFromEnv({
      GOOGLE_API_KEY: "k",
      RESEARCH_OS_MODEL_PRICING: JSON.stringify(PRICING),
    });
    assert.equal(provider?.name, "gemini");
  });

  test("a key with no pricing fails loudly at construction, not at the first call", () => {
    assert.throws(
      () => geminiProviderFromEnv({ GEMINI_API_KEY: "k" }),
      (error: ResearchError) => error.code === "validation_failed" && /RESEARCH_OS_MODEL_PRICING/.test(error.message),
    );
  });
});
