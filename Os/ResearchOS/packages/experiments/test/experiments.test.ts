/**
 * Experiment execution, metric parsing and replication.
 *
 * The local runner is exercised for real — it spawns actual processes — because
 * the things most likely to be wrong (timeout kills, output caps, environment
 * scrubbing) cannot be observed any other way.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExperimentExecutionRequest, type ExperimentRun } from "@research-os/contracts";
import type { ResearchError } from "@research-os/shared";
import {
  LocalProcessRunner, UnavailableExperimentRunner, formatMetrics, metricSpread, metricsMatch,
  parseMetrics, summariseReplication,
} from "../src/index.ts";
import { FIXTURE_NOW as NOW } from "../../../tests/support/fixtures.ts";

const request = (overrides: Record<string, unknown> = {}) =>
  ExperimentExecutionRequest.parse({
    experimentId: "exp_1", runId: "exr_1", runtime: "node", code: "console.log('hello')",
    timeoutMs: 10_000, ...overrides,
  });

const run = (attempt: number, metrics: Record<string, number>, status = "succeeded"): ExperimentRun =>
  ({
    id: `exr_${attempt}`, projectId: "prj_1", experimentId: "exp_1", attempt, status,
    parameters: {}, stdout: "", stderr: "", exitCode: 0, metrics, artifacts: [],
    durationMs: 10, interpretation: null, reproducedRunId: null, reproductionMatched: null,
    errorMessage: null, startedAt: NOW, finishedAt: NOW, createdAt: NOW,
  }) as unknown as ExperimentRun;

describe("UnavailableExperimentRunner", () => {
  test("refuses every request and says why", async () => {
    const runner = new UnavailableExperimentRunner();
    const result = await runner.execute(request());

    assert.equal(result.status, "failed");
    assert.match(String(result.errorMessage), /^BLOCKED:/, "a blocked experiment must be labelled, not silently empty");
    assert.deepEqual(result.metrics, {}, "and must never carry fabricated numbers");
    assert.equal((await runner.healthCheck()).ok, false);
  });

  test("carries a custom reason through to the report", async () => {
    const runner = new UnavailableExperimentRunner("No container runtime on this host.");
    const result = await runner.execute(request());
    assert.match(String(result.errorMessage), /No container runtime/);
  });
});

describe("metric parsing", () => {
  test("reads JSON marker lines", () => {
    const metrics = parseMetrics(["noise", 'RESEARCHOS_METRIC {"accuracy": 0.87, "f1": 0.83}', "more noise"].join("\n"));
    assert.deepEqual(metrics, { accuracy: 0.87, f1: 0.83 });
  });

  test("reads key=value marker lines", () => {
    assert.deepEqual(parseMetrics("RESEARCHOS_METRIC accuracy=0.91"), { accuracy: 0.91 });
  });

  test("ignores everything that is not a marker line", () => {
    const stdout = ["accuracy: 0.99", "The model achieved 0.99 accuracy.", '{"accuracy": 0.99}'].join("\n");
    assert.deepEqual(parseMetrics(stdout), {}, "prose is never parsed as data");
  });

  test("a malformed marker line is skipped rather than guessed at", () => {
    assert.deepEqual(parseMetrics("RESEARCHOS_METRIC {not json}"), {});
    assert.deepEqual(parseMetrics("RESEARCHOS_METRIC accuracy=notanumber"), {});
  });

  test("non-finite values are dropped", () => {
    assert.deepEqual(parseMetrics('RESEARCHOS_METRIC {"a": null, "b": "x", "c": 1}'), { c: 1 });
  });

  test("later values win", () => {
    assert.deepEqual(parseMetrics("RESEARCHOS_METRIC a=1\nRESEARCHOS_METRIC a=2"), { a: 2 });
  });

  test("formatMetrics round-trips", () => {
    assert.deepEqual(parseMetrics(formatMetrics({ accuracy: 0.5 })), { accuracy: 0.5 });
  });
});

describe("replication", () => {
  test("one run is not evidence of reproducibility", () => {
    const summary = summariseReplication("exp_1", [run(1, { accuracy: 0.9 })]);
    assert.equal(summary.replications, 0);
    assert.equal(summary.reproducibilityScore, 0, "a single run scoring 1 would present absence of evidence as a strong result");
  });

  test("a matching second run counts as a replication", () => {
    const summary = summariseReplication("exp_1", [run(1, { accuracy: 0.90 }), run(2, { accuracy: 0.91 })]);
    assert.equal(summary.replications, 1);
    assert.equal(summary.failedReplications, 0);
    assert.equal(summary.reproducibilityScore, 1);
  });

  test("a materially different result is a failed replication, not a second confirmation", () => {
    const summary = summariseReplication("exp_1", [run(1, { accuracy: 0.90 }), run(2, { accuracy: 0.40 })]);
    assert.equal(summary.replications, 0);
    assert.equal(summary.failedReplications, 1);
    assert.equal(summary.reproducibilityScore, 0);
  });

  test("failed runs are counted but never compared", () => {
    const summary = summariseReplication("exp_1", [run(1, { accuracy: 0.9 }), run(2, {}, "failed"), run(3, { accuracy: 0.9 })]);
    assert.equal(summary.totalRuns, 3);
    assert.equal(summary.successfulRuns, 2);
    assert.equal(summary.replications, 1);
  });

  test("spread across runs is reported, because a wide spread is itself a finding", () => {
    const summary = summariseReplication("exp_1", [run(1, { accuracy: 0.5 }), run(2, { accuracy: 0.9 })]);
    const spread = summary.metricVariance["accuracy"];
    assert.equal(spread?.min, 0.5);
    assert.equal(spread?.max, 0.9);
    assert.equal(spread?.mean, 0.7);
    assert.ok((spread?.stdDev ?? 0) > 0.19);
  });

  test("runs sharing no metric do not replicate each other", () => {
    assert.equal(metricsMatch({ a: 1 }, { b: 1 }), false, "nothing in common is not agreement");
    assert.equal(metricsMatch({}, {}), false);
  });

  test("tolerance is relative, with an absolute floor near zero", () => {
    assert.equal(metricsMatch({ a: 100 }, { a: 105 }), true, "5% is inside the default 10%");
    assert.equal(metricsMatch({ a: 100 }, { a: 120 }), false);
    assert.equal(metricsMatch({ a: 0 }, { a: 0 }), true);
    assert.equal(metricsMatch({ a: 1 }, { a: 1.05 }, { relativeTolerance: 0.01 }), false, "tolerance is configurable");
  });

  test("metricSpread handles the empty case", () => {
    assert.equal(metricSpread([]), null);
  });
});

describe("LocalProcessRunner", () => {
  test("refuses to be constructed without an explicit acknowledgement", () => {
    assert.throws(
      () => new LocalProcessRunner({ acknowledgeUnsandboxedExecution: false }),
      (error: ResearchError) => error.code === "forbidden" && /no sandbox/.test(error.message),
      "running model-written code must never be something a default turns on",
    );
  });

  const runner = new LocalProcessRunner({ acknowledgeUnsandboxedExecution: true, runtimes: ["node"] });

  test("executes code and reports its metrics", async () => {
    const result = await runner.execute(request({
      code: "console.log('working'); console.log('RESEARCHOS_METRIC ' + JSON.stringify({ accuracy: 0.87 }));",
    }));

    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /working/);
    assert.deepEqual(result.metrics, { accuracy: 0.87 });
    assert.ok(result.durationMs >= 0);
  });

  test("records the environment, so the run is reproducible", async () => {
    const result = await runner.execute(request({ code: "console.log(1)", parameters: { randomSeed: 42 } }));

    assert.equal(result.environment.runtime, "node");
    assert.ok(result.environment.runtimeVersion?.startsWith("v"), "the interpreter version is part of the result");
    assert.equal(result.environment.randomSeed, 42);
    assert.ok(result.environment.platform);
  });

  test("a non-zero exit is a failure with the code recorded", async () => {
    const result = await runner.execute(request({ code: "process.exit(3)" }));
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 3);
    assert.match(String(result.errorMessage), /code 3/);
  });

  test("a hanging experiment is killed at the timeout", async () => {
    const started = Date.now();
    const result = await runner.execute(request({ code: "setInterval(() => {}, 1000);", timeoutMs: 300 }));

    assert.equal(result.status, "timed_out");
    assert.match(String(result.errorMessage), /exceeded 300ms/);
    assert.ok(Date.now() - started < 5000, "the kill must actually happen, not merely be reported");
  });

  test("the parent environment is not inherited, so secrets are not visible", async () => {
    process.env["RESEARCHOS_TEST_SECRET"] = "super-secret-value";
    try {
      const result = await runner.execute(request({
        code: "console.log('SECRET=' + (process.env.RESEARCHOS_TEST_SECRET ?? 'absent'))",
      }));
      assert.match(result.stdout, /SECRET=absent/, "an experiment must not be able to read the host's API keys");
    } finally {
      delete process.env["RESEARCHOS_TEST_SECRET"];
    }
  });

  test("parameters reach the experiment as scoped variables", async () => {
    const result = await runner.execute(request({
      code: "console.log('P=' + process.env.RESEARCHOS_PARAM_THRESHOLD)",
      parameters: { threshold: 0.5 },
    }));
    assert.match(result.stdout, /P=0\.5/);
  });

  test("output is capped", async () => {
    const result = await runner.execute(request({
      code: "for (let i = 0; i < 100000; i++) console.log('x'.repeat(80));",
      maxOutputBytes: 5000,
    }));
    assert.ok(result.stdout.length <= 5000, "a runaway loop must not fill memory");
  });

  test("an unsupported runtime is refused rather than attempted", async () => {
    const result = await runner.execute(request({ runtime: "python", code: "print(1)" }));
    assert.match(String(result.errorMessage), /BLOCKED.*python/);
  });

  test("an input file that traverses is refused", async () => {
    const result = await runner.execute(request({
      code: "console.log(1)",
      inputFiles: [{ path: "../escaped.txt", contents: "x" }],
    }));
    assert.match(String(result.errorMessage), /BLOCKED.*traverse/);
  });

  test("input files are placed in the working directory", async () => {
    const result = await runner.execute(request({
      // `.mjs`, so ESM import — not `require`.
      code: "import { readFileSync } from 'node:fs'; console.log(readFileSync('data.txt', 'utf8'));",
      inputFiles: [{ path: "data.txt", contents: "the dataset" }],
      runtime: "node",
    }));
    assert.match(result.stdout, /the dataset/);
  });
});
