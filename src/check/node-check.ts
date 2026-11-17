import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createSteps,
  definePipeline,
  type PipelineContext,
  type PipelineRun,
  type Step,
} from "../core/pipeline.js";
import {
  resolveNodeCheckPlan,
  decodeNodeCheckPlan,
  type NodeCheckPlan,
} from "../utilities/node-check-plan.js";
import { vitestCheckReport } from "../node/vitest-report.js";
import { prepareCheckReport, readCheckReportFile } from "../node/check-files.js";
import type { CheckProcessOutcome, CheckReportResult } from "../utilities/check-report.js";
import { runCheckProcess } from "./process.js";

/** Original pipeline result, independent native outcomes and collected test-report envelopes. */
export interface NodeCheckExecution {
  version: 1;
  run: PipelineRun;
  commands: { id: string; process: CheckProcessOutcome }[];
  reports: { stepId: string; path: string; result: CheckReportResult }[];
}

/** Load only JSON and a committed Bun text lock. No Cloud access or application-module evaluation. */
export async function readNodeCheckPlan(root: string): Promise<NodeCheckPlan> {
  const json = async (path: string): Promise<unknown> => {
    const file = resolve(root, path),
      stat = await lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024)
      throw new TypeError(`Invalid or oversized ${path}.`);
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  };
  for (const lock of [
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
  ]) {
    try {
      await lstat(resolve(root, lock));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new TypeError(`Ambiguous package manager: remove ${lock}.`);
  }
  if (!(await lstat(resolve(root, "bun.lock"))).isFile())
    throw new TypeError("Commit a regular bun.lock file.");
  return resolveNodeCheckPlan(await json("tubeless.check.json"), await json("package.json"));
}

/** Execute an admitted plan with the ordinary Tubeless scheduler. All checks run unless fail-fast or cancellation stops them. */
export async function runNodeCheck(
  input: NodeCheckPlan,
  context: Partial<PipelineContext> & { cwd: string },
  options: { dryRun?: boolean } = {}
): Promise<NodeCheckExecution> {
  if (process.platform === "win32")
    throw new TypeError("The node-check-v1 recipe requires a POSIX host; Windows is unsupported.");
  const plan = decodeNodeCheckPlan(input);
  if (!plan) throw new TypeError("Invalid Node check plan.");
  if (process.versions.node.split(".")[0] !== plan.toolchain.node)
    throw new TypeError("The node-check-v1 recipe requires Node 24.");
  // Re-resolve source, including script bodies, immediately before any execution.
  const sourcePlan = await readNodeCheckPlan(context.cwd);
  if (JSON.stringify(sourcePlan) !== JSON.stringify(plan))
    throw new TypeError("Check plan differs from repository configuration.");
  const { step } = createSteps();
  const steps: Step<string, CheckProcessOutcome, object>[] = [];
  const commands: NodeCheckExecution["commands"] = [];
  const reports: NodeCheckExecution["reports"] = plan.commands
    .filter((command) => command.kind === "vitest")
    .map(({ id: stepId, report: { path } }) => ({ stepId, path, result: { state: "missing" } }));
  for (const command of plan.commands) {
    steps.push(
      step(command.id, {
        description: command.reason,
        dependsOn: command.dependsOn.map((id) => steps.find((item) => item.id === id)!),
        dryRun: "skip",
        run: async (_inputs, ctx) => {
          if (command.kind === "vitest") await prepareCheckReport(ctx.cwd, command.report.path);
          if (command.kind === "install") {
            // Bun version is checked before installation; it cannot silently select another resolver.
            let version = "";
            const probe = await runCheckProcess(["bun", "--version"], 5000, {
              ...ctx,
              log: {
                ...ctx.log,
                log: (text) => {
                  version += String(text);
                },
              },
            });
            ctx.signal?.throwIfAborted();
            if (
              probe.status !== "exited" ||
              probe.exitCode !== 0 ||
              version.trim() !== plan.toolchain.bun
            )
              throw new TypeError("The node-check-v1 recipe requires Bun 1.4.4.");
          }
          const outcome = await runCheckProcess(command.argv, command.timeoutMs, ctx);
          commands.push({ id: command.id, process: outcome });
          if (command.kind === "vitest") {
            const file = await readCheckReportFile(ctx.cwd, command.report.path);
            const result =
              "result" in file
                ? file.result
                : vitestCheckReport(file.content, {
                    root: ctx.cwd,
                    toolVersion: command.report.version,
                    context: {
                      pipelineId: "node-check",
                      runId: ctx.runId,
                      stepId: command.id,
                      attemptId: ctx.attemptId,
                    },
                    process: outcome,
                  });
            reports.find((report) => report.stepId === command.id)!.result = result;
            ctx.signal?.throwIfAborted();
            if (
              outcome.status === "exited" &&
              outcome.exitCode === 0 &&
              (result.state !== "available" ||
                result.report.completeness !== "complete" ||
                result.report.tests.some((test) => test.outcome === "failed") ||
                result.report.failures.length)
            )
              throw new Error(
                `Expected complete Vitest report for ${command.id}; collection cannot establish a complete gate.`
              );
          }
          ctx.signal?.throwIfAborted();
          if (outcome.status !== "exited" || outcome.exitCode !== 0)
            throw Object.assign(
              new Error(
                `Native command ${command.id}: ${outcome.status} (${outcome.exitCode ?? outcome.signal ?? "unknown"}).`
              ),
              { code: "NATIVE_PROCESS_FAILED" }
            );
          return outcome;
        },
      })
    );
  }
  const pipeline = definePipeline({ id: "node-check", steps });
  const run = await pipeline.run(
    {},
    { maxConcurrency: plan.maxConcurrency, dryRun: options.dryRun },
    context
  );
  return { version: 1, run, commands, reports };
}
