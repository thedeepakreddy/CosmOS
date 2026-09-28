/**
 * Executes an experiment as a local child process.
 *
 * READ THIS BEFORE ENABLING IT.
 *
 * This runner executes code a language model wrote, on the machine it is running
 * on, with that machine's user permissions. It is **not a sandbox**. Node offers
 * no primitive that would make it one — no syscall filter, no filesystem jail,
 * no memory cap that survives a fork. The controls here are real but they are
 * the outer layer of a defence, not the whole of it:
 *
 *   - a hard wall-clock timeout, enforced by killing the process group;
 *   - output byte caps, so a runaway loop cannot fill memory or disk;
 *   - a scrubbed environment — nothing from the parent process is inherited, so
 *     API keys and credentials are not visible to the experiment;
 *   - a fresh temporary working directory, removed afterwards;
 *   - network access off unless the request explicitly asks for it (advisory:
 *     it is passed to the code as an environment variable, not enforced).
 *
 * Run this only inside a disposable container or VM whose loss you would not
 * mind. On any other host, prefer `UnavailableExperimentRunner` and accept that
 * experiments come back `BLOCKED` — an honest gap beats a result obtained by
 * handing an agent your laptop.
 *
 * `acknowledgeUnsandboxedExecution` exists so that enabling this is a decision
 * someone typed, not a default they inherited.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExperimentEnvironment, ExperimentExecutionRequest, ExperimentExecutionResult, ExperimentRuntime,
} from "@research-os/contracts";
import { err } from "@research-os/shared";
import { parseMetrics } from "./metrics.ts";
import { blockedResult, type ExperimentRunner } from "./runner.ts";

interface RuntimeSpec {
  readonly command: string;
  readonly args: (scriptPath: string) => string[];
  readonly filename: string;
  readonly versionArgs: readonly string[];
}

/**
 * Node experiments are written to a `.mjs` file, so they are ES modules and
 * must use `import` rather than `require`. Worth stating plainly because an
 * agent asked to write "a Node script" will otherwise reach for `require` about
 * half the time, and the failure it produces names neither cause nor fix.
 */
const RUNTIMES: Record<ExperimentRuntime, RuntimeSpec> = {
  python: { command: "python3", args: (path) => [path], filename: "experiment.py", versionArgs: ["--version"] },
  node: { command: "node", args: (path) => [path], filename: "experiment.mjs", versionArgs: ["--version"] },
  shell: { command: "sh", args: (path) => [path], filename: "experiment.sh", versionArgs: ["-c", "echo sh"] },
};

export interface LocalProcessRunnerOptions {
  /**
   * Must be `true`. Naming it explicitly is the point: this runner has no
   * sandbox, and enabling it should be a deliberate act rather than a default.
   */
  readonly acknowledgeUnsandboxedExecution: boolean;
  readonly runtimes?: readonly ExperimentRuntime[];
  readonly maxTimeoutMs?: number;
  /** Environment variables to pass through. Empty by default — nothing is inherited. */
  readonly passThroughEnv?: readonly string[];
}

export class LocalProcessRunner implements ExperimentRunner {
  readonly name = "local-process";
  readonly supportedRuntimes: readonly ExperimentRuntime[];
  readonly #maxTimeoutMs: number;
  readonly #passThroughEnv: readonly string[];

  constructor(options: LocalProcessRunnerOptions) {
    if (!options.acknowledgeUnsandboxedExecution) {
      throw err.forbidden(
        "LocalProcessRunner executes model-written code with no sandbox. Construct it with " +
          "acknowledgeUnsandboxedExecution: true, and only inside a disposable container.",
      );
    }
    this.supportedRuntimes = options.runtimes ?? ["python", "node", "shell"];
    this.#maxTimeoutMs = options.maxTimeoutMs ?? 300_000;
    this.#passThroughEnv = options.passThroughEnv ?? [];
  }

  async execute(request: ExperimentExecutionRequest): Promise<ExperimentExecutionResult> {
    if (!this.supportedRuntimes.includes(request.runtime)) {
      return blockedResult(request.runtime, `this runner does not support the "${request.runtime}" runtime`);
    }
    const spec = RUNTIMES[request.runtime];

    const workdir = await mkdtemp(join(tmpdir(), "researchos-exp-"));
    const startedAt = Date.now();

    try {
      const scriptPath = join(workdir, spec.filename);
      await writeFile(scriptPath, request.code, "utf8");
      for (const file of request.inputFiles) {
        // Input file paths come from a model. A traversal here would write
        // outside the temp directory, so the shape is checked rather than trusted.
        if (file.path.includes("..") || file.path.startsWith("/")) {
          return blockedResult(request.runtime, `input file path "${file.path}" must be relative and must not traverse`);
        }
        await writeFile(join(workdir, file.path), file.contents, "utf8");
      }

      const timeoutMs = Math.min(request.timeoutMs, this.#maxTimeoutMs);
      const outcome = await this.#spawn(spec, scriptPath, workdir, request, timeoutMs);
      const durationMs = Date.now() - startedAt;

      return {
        status: outcome.timedOut ? "timed_out" : outcome.exitCode === 0 ? "succeeded" : "failed",
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        // Metrics are read from marker lines only, so nothing is inferred from
        // prose the experiment happened to print.
        metrics: parseMetrics(outcome.stdout),
        artifacts: [],
        durationMs,
        errorMessage: outcome.timedOut
          ? `Experiment exceeded ${timeoutMs}ms and was terminated.`
          : outcome.exitCode === 0
            ? null
            : `Exited with code ${outcome.exitCode}.`,
        environment: await this.#describeEnvironment(request, spec),
      };
    } catch (error) {
      return blockedResult(request.runtime, error instanceof Error ? error.message : String(error));
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {
        /* a leftover temp directory must not fail the experiment */
      });
    }
  }

  #spawn(
    spec: RuntimeSpec,
    scriptPath: string,
    workdir: string,
    request: ExperimentExecutionRequest,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {
        // Deliberately minimal. The parent's environment holds API keys; an
        // experiment has no business seeing them.
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: workdir,
        RESEARCHOS_ALLOW_NETWORK: request.allowNetwork ? "1" : "0",
      };
      for (const name of this.#passThroughEnv) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      for (const [key, value] of Object.entries(request.parameters)) {
        env[`RESEARCHOS_PARAM_${key.toUpperCase()}`] = String(value);
      }

      const child = spawn(spec.command, spec.args(scriptPath), {
        cwd: workdir,
        env,
        // Its own process group, so a killed experiment takes its children with
        // it rather than orphaning them.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const capture = (stream: NodeJS.ReadableStream | null, append: (chunk: string) => void): void => {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => append(chunk));
      };
      capture(child.stdout, (chunk) => {
        if (stdout.length < request.maxOutputBytes) stdout += chunk;
      });
      capture(child.stderr, (chunk) => {
        if (stderr.length < request.maxOutputBytes) stderr += chunk;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // Negative pid signals the whole process group.
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      const settle = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, request.maxOutputBytes),
          stderr: stderr.slice(0, request.maxOutputBytes),
          exitCode,
          timedOut,
        });
      };

      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        settle(null);
      });
      child.on("close", (code) => settle(code));
    });
  }

  /**
   * Records the environment the run actually happened in.
   *
   * Without this an experiment is not reproducible: "it worked" means nothing
   * without the interpreter version it worked under. Variable *names* are
   * recorded, never values — a reproducibility record must not become a place
   * secrets are written down.
   */
  async #describeEnvironment(request: ExperimentExecutionRequest, spec: RuntimeSpec): Promise<ExperimentEnvironment> {
    const runtimeVersion = await this.#probeVersion(spec);
    const seed = request.parameters["randomSeed"];
    return {
      runtime: request.runtime,
      runtimeVersion,
      dependencies: [...request.dependencies],
      platform: `${process.platform}-${process.arch}`,
      envVarNames: ["PATH", "HOME", "RESEARCHOS_ALLOW_NETWORK", ...this.#passThroughEnv],
      randomSeed: typeof seed === "number" ? seed : null,
    };
  }

  #probeVersion(spec: RuntimeSpec): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(spec.command, [...spec.versionArgs], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(output.trim() || null));
    });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const available: string[] = [];
    for (const runtime of this.supportedRuntimes) {
      const version = await this.#probeVersion(RUNTIMES[runtime]);
      if (version) available.push(`${runtime} (${version})`);
    }
    return available.length > 0
      ? { ok: true, detail: available.join(", ") }
      : { ok: false, detail: "no supported runtime is on PATH" };
  }
}
