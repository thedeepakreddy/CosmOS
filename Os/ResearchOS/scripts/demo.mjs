/**
 * Launches the API and the test UI together, for a demonstration run.
 *
 * Two modes, and the difference is entirely in configuration — no code path
 * changes between them:
 *
 *   npm run demo        the API starts with no model provider. Every research
 *                       task fails with the reason and its fix. The UI, the
 *                       event stream, the API contract and every refusal path
 *                       are exercisable; the research itself is not.
 *
 *   npm run demo:live   the API starts with whichever vendors have a key in
 *                       *your* environment — ANTHROPIC_API_KEY, GEMINI_API_KEY,
 *                       or both. This script never reads, prints, stores or
 *                       transmits a key anywhere except into the child process
 *                       it starts.
 *
 *   npm run demo:gemini same, but with Anthropic explicitly withheld, so the
 *                       run routes to Gemini even in a shell that has both.
 *
 * Nothing here is imported by the platform. It is an operator convenience that
 * sets environment variables and spawns two processes.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const geminiOnly = process.argv.includes("--gemini");
const live = geminiOnly || process.argv.includes("--live");
const API_PORT = process.env.RESEARCH_OS_PORT ?? "8080";
const WEB_PORT = process.env.RESEARCH_OS_WEB_PORT ?? "5173";
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/**
 * Pricing is mandatory: ResearchOS refuses to run a model it cannot price,
 * because cost accounting is what enforces the cost budget.
 *
 * A demo that has no configured pricing gets a zero table rather than invented
 * numbers. Zeros are obviously not real rates, where plausible-looking ones
 * would quietly corrupt every cost figure in the ledger and the report.
 */
const ZERO_PRICING = JSON.stringify({
  "claude-opus-5": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
  "claude-sonnet-5": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
  "claude-haiku-4-5-20251001": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
  "gemini-3.8-flash": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
  "gemini-flash-latest": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
  "gemini-flash-lite-latest": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
  "gemini-embedding-001": { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 },
});

if (!existsSync(resolve("apps/api/dist/main.js"))) {
  console.error("Build first:  npm run build");
  process.exit(1);
}

const env = {
  ...process.env,
  RESEARCH_OS_HOST: "127.0.0.1",
  RESEARCH_OS_PORT: API_PORT,
  // The UI proxies /api/* and /health through its own origin, so CORS is not
  // needed for it. Set anyway, so pointing a browser straight at the API also works.
  RESEARCH_OS_CORS_ORIGINS: WEB_ORIGIN,
  RESEARCH_OS_EMBEDDED_WORKER: "true",
  RESEARCH_OS_LOG_FORMAT: process.env.RESEARCH_OS_LOG_FORMAT ?? "pretty",
  RESEARCH_OS_DATABASE_URL: process.env.RESEARCH_OS_DATABASE_URL ?? "sqlite:.data/demo.db",
};

const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const vendors = [];

if (live) {
  if (geminiOnly) {
    // Anthropic is withheld so `--gemini` means Gemini even in a shell holding
    // both keys. Otherwise "instead of Claude" would quietly become "alongside".
    delete env.ANTHROPIC_API_KEY;
  } else if (process.env.ANTHROPIC_API_KEY) {
    vendors.push("Anthropic");
  }
  if (geminiKey) {
    // The provider reads GEMINI_API_KEY first; normalising here means a shell
    // that only has GOOGLE_API_KEY works without the user knowing the order.
    env.GEMINI_API_KEY = geminiKey;
    vendors.push("Gemini");
  }

  if (vendors.length === 0) {
    console.error([
      "",
      geminiOnly
        ? "  GEMINI_API_KEY is not set, so there is nothing to route to."
        : "  Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set, so there is nothing to route to.",
      "",
      "  Put it in .env.local (gitignored, and read automatically):",
      "",
      "      echo 'GEMINI_API_KEY=your-key' >> .env.local",
      "      npm run demo:gemini",
      "",
      "  A shell export works too, but only for servers started from that same",
      "  shell afterwards — a server already running keeps the environment it",
      "  was started with, which is the usual reason a new key appears to do",
      "  nothing.",
      "",
      "  Without a key, `npm run demo` still starts everything — research tasks",
      "  will fail with the missing configuration named, which is correct.",
      "",
    ].join("\n"));
    process.exit(1);
  }
  env.RESEARCH_OS_MODEL_PRICING = process.env.RESEARCH_OS_MODEL_PRICING ?? ZERO_PRICING;
} else {
  // Explicitly withheld, so `npm run demo` is the unconfigured path even in a
  // shell that happens to have keys exported.
  delete env.ANTHROPIC_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.RESEARCH_OS_MODEL_PRICING;
}

const banner = [
  "",
  `  ResearchOS demo — ${live ? `LIVE (${vendors.join(" + ")})` : "UNCONFIGURED (no model provider)"}`,
  "",
  `  UI    http://127.0.0.1:${WEB_PORT}`,
  `  API   http://127.0.0.1:${API_PORT}`,
  `  DB    ${env.RESEARCH_OS_DATABASE_URL}`,
  "",
];

if (live && !process.env.RESEARCH_OS_MODEL_PRICING) {
  banner.push(
    "  Pricing is not configured, so a zero table is in use: every cost in the",
    "  ledger and the report will read $0.00 and the maxCostUsd budget cannot",
    "  trip. Token, model-call, tool-call, task and wall-clock budgets still do.",
    "  Set RESEARCH_OS_MODEL_PRICING with real rates for real cost accounting.",
    "",
  );
}
if (live && vendors.length === 1) {
  banner.push(
    `  One provider (${vendors[0]}). Verification and debate judging will be`,
    "  self-reviews, and the engine reports that gap at startup. Export both",
    "  ANTHROPIC_API_KEY and GEMINI_API_KEY for genuinely independent review.",
    "",
  );
}
if (live && vendors.includes("Gemini")) {
  banner.push(
    "  Gemini brings an embedding model, so retrieval is hybrid rather than",
    "  lexical-only. That gap should be absent from /health.",
    "",
  );
}
if (!live) {
  banner.push(
    "  No model provider: every research task will fail with",
    "  \"No model provider is configured…\". That is ResearchOS being honest,",
    "  not a broken demo. Use `npm run demo:gemini` or `npm run demo:live`.",
    "",
  );
}
banner.push(
  "  ResearchOS ships no search engine. This demo registers a `supplied_corpus`",
  "  tool that answers discovery with the URLs you paste into the UI — nothing",
  "  else. It searches nowhere. Without it, discovery reports BLOCKED and every",
  "  step that depends on it stalls, which is why the demo wires it and the",
  "  platform does not.",
  "",
);
/**
 * Asks Gemini which models this key can actually call, before starting.
 *
 * A model id is not a property of the code: Google retires ids and restricts
 * others to existing users, so a catalog compiled from documentation goes stale
 * silently. Without this the failure arrives per-task, mid-run, as "no longer
 * available to new users" — which looks like a broken pipeline rather than a
 * stale constant. Checked here so it is a startup message naming the fix.
 *
 * The key is read from the environment and never printed.
 */
async function preflightGemini() {
  const key = env.GEMINI_API_KEY;
  if (!key) return;
  const base = env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
  const { GEMINI_MODEL_SPECS } = await import("@research-os/model-router");
  const configured = GEMINI_MODEL_SPECS.filter((spec) => !spec.capabilities.includes("embedding"));

  /*
   * Each configured model is *called*, not merely looked up.
   *
   * `ListModels` is not a reachability check: a retired id still appears there
   * while `generateContent` answers "no longer available to new users", and an
   * earlier version of this preflight reported such a catalog as healthy. One
   * token per model is the cheapest question that cannot be answered wrongly.
   */
  const results = await Promise.all(configured.map(async (spec) => {
    try {
      const response = await fetch(`${base}/models/${spec.id}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ok" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      if (response.ok) return { id: spec.id, ok: true };
      const text = await response.text();
      let detail = text.slice(0, 110);
      try { detail = JSON.parse(text).error?.message?.slice(0, 110) ?? detail; } catch { /* raw body */ }
      return { id: spec.id, ok: false, status: response.status, detail };
    } catch (error) {
      return { id: spec.id, ok: false, status: 0, detail: error.message };
    }
  }));

  const broken = results.filter((r) => !r.ok);
  console.log("  Gemini model check (one token each):");
  for (const r of results) {
    console.log(r.ok ? `    OK       ${r.id}` : `    FAILED   ${r.id}  ${r.status} ${r.detail}`);
  }
  if (broken.length === configured.length) {
    console.log("");
    console.log("  No configured model is callable, so every research task will fail.");
    console.log("  Fix GEMINI_MODEL_SPECS in packages/model-router/src/catalog.ts, then rebuild.");
    console.log("  `node --import ./scripts/register.mjs scripts/gemini-models.mjs` lists what this key can use.");
  } else if (broken.length > 0) {
    console.log("");
    console.log(`  ${broken.length} model(s) unusable; routing will fall back to the rest.`);
  }
  console.log("");
}

console.log(banner.join("\n"));
if (live && vendors.includes("Gemini")) await preflightGemini();

const children = [
  spawn("node", ["scripts/demo-server.mjs"], { env, stdio: "inherit" }),
  spawn("node", ["apps/web/server.mjs"], {
    env: { ...process.env, RESEARCH_OS_WEB_PORT: WEB_PORT, RESEARCH_OS_API_URL: `http://127.0.0.1:${API_PORT}` },
    stdio: "inherit",
  }),
];

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
