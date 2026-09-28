#!/usr/bin/env node
/**
 * Generates package.json + tsconfig.json for every workspace from architecture.json.
 * Running this is idempotent: it is the mechanism that keeps the declared module
 * graph and the on-disk build graph from drifting apart.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arch = JSON.parse(readFileSync(join(root, "architecture.json"), "utf8"));
const EXTERNAL_VERSIONS = JSON.parse(readFileSync(join(root, "external-versions.json"), "utf8"));

const all = [
  ...Object.entries(arch.packages).map(([name, cfg]) => ({ name, cfg, dir: `packages/${name}` })),
  ...Object.entries(arch.apps).map(([name, cfg]) => ({ name, cfg, dir: `apps/${name}` })),
];

const dirOf = (name) =>
  arch.packages[name] ? `packages/${name}` : `apps/${name}`;

for (const { name, cfg, dir } of all) {
  const abs = join(root, dir);
  mkdirSync(join(abs, "src"), { recursive: true });
  // `test/` too: tsconfig.test.json globs `packages/*/test/**`, and a missing
  // directory makes a new package's first test silently unrunnable.
  mkdirSync(join(abs, "test"), { recursive: true });

  const dependencies = {};
  for (const dep of cfg.deps) dependencies[`${arch.scope}/${dep}`] = "*";
  for (const ext of cfg.external) {
    const version = EXTERNAL_VERSIONS[ext];
    if (!version) throw new Error(`No pinned version for external dependency "${ext}" (required by ${name}). Add it to external-versions.json.`);
    dependencies[ext] = version;
  }

  const isApp = Boolean(arch.apps[name]);
  const pkg = {
    name: `${arch.scope}/${name}`,
    version: "0.1.0",
    private: true,
    type: "module",
    description: cfg.description,
    exports: isApp
      ? undefined
      : { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    main: isApp ? "./dist/main.js" : "./dist/index.js",
    types: isApp ? undefined : "./dist/index.d.ts",
    files: ["dist"],
    scripts: { build: "tsc -b", clean: "tsc -b --clean" },
    dependencies: Object.keys(dependencies).length ? dependencies : undefined,
  };
  writeFileSync(join(abs, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  const tsconfig = {
    extends: relative(abs, join(root, "tsconfig.base.json")).replaceAll("\\", "/"),
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src/**/*"],
    references: cfg.deps.map((d) => ({
      path: relative(abs, join(root, dirOf(d))).replaceAll("\\", "/"),
    })),
  };
  writeFileSync(join(abs, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");

  const indexPath = join(abs, "src", isApp ? "main.ts" : "index.ts");
  if (!existsSync(indexPath)) writeFileSync(indexPath, "export {};\n");
}

// Root solution tsconfig: references every workspace, builds nothing itself.
writeFileSync(
  join(root, "tsconfig.json"),
  JSON.stringify(
    {
      $comment: "Solution file. `tsc -b` walks these references in dependency order.",
      files: [],
      references: all.map(({ dir }) => ({ path: `./${dir}` })),
    },
    null,
    2,
  ) + "\n",
);

// Typecheck-only project for tests (tests are never emitted into dist).
writeFileSync(
  join(root, "tsconfig.test.json"),
  JSON.stringify(
    {
      $comment: "Typechecks test files without emitting. Run after `tsc -b`.",
      extends: "./tsconfig.base.json",
      compilerOptions: {
        noEmit: true,
        composite: false,
        incremental: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        allowImportingTsExtensions: true,
        rootDir: ".",
      },
      include: ["packages/*/test/**/*.ts", "apps/*/test/**/*.ts", "tests/**/*.ts"],
    },
    null,
    2,
  ) + "\n",
);

console.log(`Generated ${all.length} workspaces + root tsconfig solution.`);
