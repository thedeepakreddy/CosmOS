/**
 * Lists the Gemini models your key can actually use.
 *
 * Model availability is not a property of the code: Google retires ids and
 * restricts others to existing users, so a catalog compiled from documentation
 * goes stale silently and the failure arrives as "no longer available to new
 * users" in the middle of a run. This asks the API instead of guessing.
 *
 * Reads GEMINI_API_KEY (or GOOGLE_API_KEY) from the environment and never
 * prints it. Run it the same way the demo runs, so `.env.local` is picked up:
 *
 *     node --import ./scripts/register.mjs scripts/gemini-models.mjs
 */
import { GEMINI_MODEL_SPECS } from "@research-os/model-router";

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("\n  GEMINI_API_KEY is not set. Put it in .env.local and run this with:\n");
  console.error("      node --import ./scripts/register.mjs scripts/gemini-models.mjs\n");
  process.exit(1);
}

const base = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";

const response = await fetch(`${base}/models?pageSize=200`, {
  headers: { "x-goog-api-key": apiKey },
});
const text = await response.text();

if (!response.ok) {
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text);
    if (parsed.error?.message) detail = parsed.error.message;
  } catch { /* the raw body is the best available detail */ }
  console.error(`\n  ListModels failed with HTTP ${response.status}: ${detail}\n`);
  process.exit(1);
}

const models = (JSON.parse(text).models ?? [])
  .filter((model) => (model.supportedGenerationMethods ?? []).includes("generateContent"))
  .map((model) => ({
    id: String(model.name).replace(/^models\//, ""),
    input: model.inputTokenLimit ?? 0,
    output: model.outputTokenLimit ?? 0,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

console.log(`\n=== models your key can call with generateContent (${models.length}) ===`);
for (const model of models) {
  console.log(`  ${model.id.padEnd(42)} in=${String(model.input).padStart(9)}  out=${String(model.output).padStart(7)}`);
}

const embedding = (JSON.parse(text).models ?? [])
  .filter((model) => (model.supportedGenerationMethods ?? []).includes("embedContent"))
  .map((model) => String(model.name).replace(/^models\//, ""));
console.log(`\n=== embedding models (${embedding.length}) ===`);
for (const id of embedding) console.log(`  ${id}`);

const available = new Set(models.map((model) => model.id));
const configured = GEMINI_MODEL_SPECS.filter((spec) => !spec.capabilities.includes("embedding"));
const missing = configured.filter((spec) => !available.has(spec.id));

console.log("\n=== ResearchOS catalog vs. what your key can reach ===");
for (const spec of configured) {
  console.log(`  ${available.has(spec.id) ? "OK     " : "MISSING"} ${spec.id}`);
}
if (missing.length > 0) {
  console.log(
    `\n  ${missing.length} configured model(s) are not available to this key. Update` +
    "\n  GEMINI_MODEL_SPECS in packages/model-router/src/catalog.ts to ids from the" +
    "\n  first list above, then rebuild. A model ResearchOS cannot reach is a" +
    "\n  routing failure mid-run, not a startup error.\n",
  );
} else {
  console.log("\n  Every configured model is reachable.\n");
}
