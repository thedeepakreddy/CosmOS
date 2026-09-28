#!/usr/bin/env node
/**
 * Enforces architecture.json against what is actually on disk.
 *
 * architecture.json is only a design document until something checks it. These
 * are the five ways the real module graph can drift away from the declared one,
 * and all five are silent failures — the build stays green while the layering
 * quietly stops being true:
 *
 *   1. a source file imports a package its workspace never declared;
 *   2. a package depends on one at the same layer or above, which is how a
 *      dependency cycle starts;
 *   3. package.json dependencies drift from architecture.json (someone edited
 *      a manifest by hand instead of regenerating it);
 *   4. tsconfig project references drift from the same, so `tsc -b` builds a
 *      different graph than the one declared;
 *   5. a product name (Echo, Aira) appears in the reusable core, which is the
 *      first step of ResearchOS quietly becoming a feature of one client.
 *
 * Run: npm run lint:arch
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arch = JSON.parse(readFileSync(join(root, "architecture.json"), "utf8"));
const externalVersions = JSON.parse(readFileSync(join(root, "external-versions.json"), "utf8"));
const SCOPE = arch.scope;

const workspaces = [
  ...Object.entries(arch.packages).map(([name, cfg]) => ({ name, cfg, dir: `packages/${name}`, isApp: false })),
  ...Object.entries(arch.apps).map(([name, cfg]) => ({ name, cfg, dir: `apps/${name}`, isApp: true })),
];
const byName = new Map(workspaces.map((w) => [w.name, w]));

const problems = [];
const fail = (workspace, message) => problems.push({ workspace, message });

/* ---------- File walking ---------- */

function sourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(join(dir, "src"));
  walk(join(dir, "test"));
  return out;
}

/**
 * Blanks out comments, keeping string literals and line numbering intact.
 *
 * Both checks below need this. Import scanning must not see a specifier quoted
 * inside prose — a doc comment reading `different information from "all agents
 * agreed"` is not a dependency on a package called "all agents agreed". And the
 * forbidden-identifier check must still see string contents, because
 * `allowInComments` permits the product name in prose but not in a prompt
 * template or a default value, which is where it would actually do harm.
 *
 * Deliberately a one-pass state machine rather than a parser: enough to answer
 * "is this token inside a comment", and it cannot be tripped by valid
 * TypeScript.
 */
function stripComments(code) {
  let out = "";
  let i = 0;
  let state = "code";
  let quote = "";
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { state = "string"; quote = ch; out += ch; i++; continue; }
      out += ch; i++; continue;
    }
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += "\n"; }
      i++; continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; i += 2; continue; }
      if (ch === "\n") out += "\n";
      i++; continue;
    }
    // string: copied through verbatim, so an import specifier survives
    if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
    if (ch === quote) state = "code";
    out += ch;
    i++;
  }
  return out;
}

/**
 * Every module specifier a file imports or re-exports.
 *
 * Matching `from "x"` anywhere is not good enough: ordinary English inside a
 * string literal produces it, and an error message reading
 * `cannot move from "draft" to "running"` was reported as a dependency on a
 * package called "draft" before this was tightened.
 *
 * So the text between the keyword and `from` is validated as an actual import
 * clause. A real one contains only identifiers, braces, commas, asterisks and
 * whitespace — `import type { A, B as C }`, `import * as ns`, `export *`. Any
 * `=`, backtick, parenthesis or quote means this is an assignment whose value
 * merely happens to contain the word "from", and it is skipped.
 *
 * This is still not a parser, but it is wrong only for code that would have to
 * be constructed deliberately to fool it.
 */
const IMPORT_CLAUSE = /^[\s\w$,{}*]*$/;

function importedSpecifiers(code) {
  const specifiers = new Set();

  for (const match of code.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g)) {
    if (!IMPORT_CLAUSE.test(match[1] ?? "")) continue;
    add(specifiers, match[2]);
  }
  for (const pattern of [
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) add(specifiers, match[1]);
  }
  return specifiers;
}

/** A real package specifier contains no whitespace and no template placeholder. */
function add(specifiers, specifier) {
  if (!specifier || /\s/.test(specifier) || specifier.includes("${")) return;
  specifiers.add(specifier);
}

/** "@research-os/persistence" -> "persistence"; "zod/v4" -> "zod"; "@a/b/c" -> "@a/b". */
function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "os", "path",
  "perf_hooks", "process", "stream", "timers", "url", "util", "worker_threads", "zlib", "sqlite", "test",
]);

/* ---------- Check 1 + 5: source imports and forbidden identifiers ---------- */

const forbidden = arch.forbiddenIdentifiers;
const forbiddenPatterns = forbidden.patterns.map((p) => new RegExp(p, "g"));
const forbiddenScope = new Set(forbidden.appliesTo);

for (const { name, cfg, dir } of workspaces) {
  const declared = new Set(cfg.deps);
  const declaredExternal = new Set(cfg.external);
  const abs = join(root, dir);

  for (const file of sourceFiles(abs)) {
    const raw = readFileSync(file, "utf8");
    const where = relative(root, file);

    // Read from the comment-stripped text so a specifier quoted in prose is
    // not mistaken for a real dependency.
    const code = stripComments(raw);
    for (const specifier of importedSpecifiers(code)) {
      const pkg = packageOf(specifier);
      if (pkg === null) continue;

      if (pkg.startsWith(`${SCOPE}/`)) {
        const depName = pkg.slice(SCOPE.length + 1);
        if (!declared.has(depName)) {
          fail(name, `${where} imports "${pkg}", which is not in architecture.json deps for "${name}". Add it there and re-run scripts/generate-workspaces.mjs, or remove the import.`);
        }
        continue;
      }
      if (NODE_BUILTINS.has(pkg)) continue;
      if (declaredExternal.has(pkg)) continue;
      // Tests may reach for the pinned dev-only engines; production src may not.
      if (where.includes("/test/") && externalVersions[pkg] !== undefined) continue;
      fail(name, `${where} imports external package "${pkg}", which is not in architecture.json external for "${name}".`);
    }

    if (forbiddenScope.has(name)) {
      const searchable = forbidden.allowInComments ? code : raw;
      // `code` still contains string literals on purpose: a product name in a
      // prompt template or a default value is leakage, only prose is exempt.
      for (const pattern of forbiddenPatterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(searchable);
        if (match) {
          fail(name, `${where} contains the product name "${match[0]}" in code. ResearchOS must stay reusable: clients attach through contracts, not by being named in the core.`);
        }
      }
    }
  }
}

/* ---------- Check 1b: declared dependencies that nothing imports ---------- */

/*
 * Drift runs both ways.
 *
 * An import nobody declared is the dangerous direction and is caught above.
 * A declaration nobody imports is the quiet one: architecture.json stops
 * describing the system and starts describing an intention, and the module
 * graph it documents is no longer the one that exists.
 */
for (const { name, cfg, dir } of workspaces) {
  if (cfg.deps.length === 0) continue;
  const used = new Set();
  for (const file of sourceFiles(join(root, dir))) {
    for (const specifier of importedSpecifiers(stripComments(readFileSync(file, "utf8")))) {
      const pkg = packageOf(specifier);
      if (pkg?.startsWith(`${SCOPE}/`)) used.add(pkg.slice(SCOPE.length + 1));
    }
  }
  for (const dep of cfg.deps) {
    if (!used.has(dep)) {
      fail(name, `declares a dependency on "${dep}" that no source or test file imports. Remove it from architecture.json and re-run scripts/generate-workspaces.mjs, or use it.`);
    }
  }
}

/* ---------- Check 2: layer ordering ---------- */

for (const { name, cfg } of workspaces) {
  for (const dep of cfg.deps) {
    const target = byName.get(dep);
    if (!target) {
      fail(name, `declares a dependency on "${dep}", which is not defined in architecture.json.`);
      continue;
    }
    if (target.cfg.layer >= cfg.layer) {
      fail(name, `is layer ${cfg.layer} but depends on "${dep}" at layer ${target.cfg.layer}. Dependencies must point strictly downward.`);
    }
  }
}

/* ---------- Check 3 + 4: manifests and tsconfig references match ---------- */

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

for (const { name, cfg, dir } of workspaces) {
  const abs = join(root, dir);

  const manifestPath = join(abs, "package.json");
  if (!existsSync(manifestPath)) {
    fail(name, `has no package.json. Run scripts/generate-workspaces.mjs.`);
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const actual = Object.keys(manifest.dependencies ?? {});
    const expected = [
      ...cfg.deps.map((dep) => `${SCOPE}/${dep}`),
      ...cfg.external,
    ];
    if (!sameSet(actual, expected)) {
      fail(name, `package.json dependencies drifted from architecture.json.\n      declared: ${expected.join(", ") || "(none)"}\n      on disk:  ${actual.join(", ") || "(none)"}\n      Fix by running scripts/generate-workspaces.mjs.`);
    }
    for (const ext of cfg.external) {
      if (externalVersions[ext] === undefined) {
        fail(name, `external dependency "${ext}" has no pinned version in external-versions.json.`);
      }
    }
  }

  const tsconfigPath = join(abs, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    fail(name, `has no tsconfig.json. Run scripts/generate-workspaces.mjs.`);
  } else {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    const actual = (tsconfig.references ?? []).map((reference) => reference.path.split("/").pop());
    if (!sameSet(actual, [...cfg.deps])) {
      fail(name, `tsconfig references drifted from architecture.json.\n      declared: ${cfg.deps.join(", ") || "(none)"}\n      on disk:  ${actual.join(", ") || "(none)"}\n      Fix by running scripts/generate-workspaces.mjs.`);
    }
  }
}

/* ---------- Report ---------- */

if (problems.length > 0) {
  console.error(`\nArchitecture violations (${problems.length}):\n`);
  for (const { workspace, message } of problems) {
    console.error(`  [${workspace}] ${message}`);
  }
  console.error("");
  process.exit(1);
}

const layers = new Map();
for (const { name, cfg } of workspaces) {
  if (!layers.has(cfg.layer)) layers.set(cfg.layer, []);
  layers.get(cfg.layer).push(name);
}
const summary = [...layers.keys()].sort((a, b) => a - b)
  .map((layer) => `  ${layer}  ${layers.get(layer).sort().join(", ")}`)
  .join("\n");
console.log(`Architecture OK — ${workspaces.length} workspaces, layering intact.\n${summary}`);
