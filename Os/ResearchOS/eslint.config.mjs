/**
 * ESLint configuration.
 *
 * `tsconfig.base.json` is already about as strict as TypeScript gets, so this
 * config deliberately does not repeat what the compiler already enforces. It
 * covers the two things the compiler cannot see:
 *
 *   - **Promises that are created and dropped.** Nearly every method in
 *     ResearchOS is async — repositories, the event bus, agents, tool calls. A
 *     forgotten `await` there does not fail; it commits half a transaction, or
 *     loses an event, or lets a research run continue past a step that never
 *     finished. `no-floating-promises` is the single highest-value rule here and
 *     it is why this config is type-aware rather than syntax-only.
 *   - **Import style**, so `verbatimModuleSyntax` has one consistent shape
 *     across 19 packages rather than each one settling on its own.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const SHARED_RULES = {
  /* The reason this config is type-aware. */
  "@typescript-eslint/no-floating-promises": [
    "error",
    {
      /*
       * `node:test` runner calls return a promise that the runner itself owns
       * and reports on; awaiting them is not how the API is used. Naming them
       * here keeps the rule fully live for every other promise in a test file —
       * a dropped `await store.projects.create(...)` is exactly the bug that
       * makes a test pass for the wrong reason.
       */
      allowForKnownSafeCalls: [
        {
          from: "package",
          package: "node:test",
          name: ["describe", "it", "test", "suite", "before", "after", "beforeEach", "afterEach"],
        },
      ],
    },
  ],
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/return-await": ["error", "in-try-catch"],

  /* Keep the `import type` / `export type` style uniform under verbatimModuleSyntax. */
  "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
  "@typescript-eslint/no-import-type-side-effects": "error",

  /* The codebase already uses `unknown` throughout; keep it that way. */
  "@typescript-eslint/no-explicit-any": "error",

  /*
   * `interface` and `type` are used deliberately here — `interface` for ports
   * meant to be implemented, `type` for unions and inferred schema output —
   * so a rule that forces one spelling would flatten a real distinction.
   */
  "@typescript-eslint/consistent-type-definitions": "off",

  /* An unused argument named with a leading underscore is intentional. */
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],

  "no-console": ["error", { allow: ["warn", "error"] }],
  eqeqeq: ["error", "always", { null: "ignore" }],
  "prefer-const": "error",
  "no-var": "error",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      ".data/**",
      "coverage/**",
    ],
  },

  js.configs.recommended,

  /*
   * Package sources. `projectService` finds each workspace's own tsconfig.json,
   * which is what gives the type-aware rules below their type information.
   */
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: SHARED_RULES,
  },

  /*
   * Tests and shared test support. These are covered by tsconfig.test.json,
   * which the project service will not find on its own because it is not named
   * `tsconfig.json` — so it is named explicitly rather than left to be linted
   * without types, which would silently disable every rule that matters most.
   */
  {
    files: ["packages/*/test/**/*.ts", "apps/*/test/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { project: ["./tsconfig.test.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: SHARED_RULES,
  },

  /* ---------- Build and operational scripts ---------- */
  {
    /*
     * `apps/web` is the test UI: a dependency-free static server and a single
     * HTML page. It is deliberately not a workspace — not in `architecture.json`,
     * not in `tsc -b`, not published — so it is linted as a plain operational
     * script rather than as part of the platform.
     */
    files: ["scripts/**/*.mjs", "apps/web/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly" },
    },
    rules: {
      /* These are CLIs. Printing to stdout is their entire job. */
      "no-console": "off",
    },
  },
);
