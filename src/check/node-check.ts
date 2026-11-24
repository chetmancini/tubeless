import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { PipelineContext, PipelineRun } from "../core/pipeline.js";
import {
  resolveNodeCheckPlan,
  decodeNodeCheckPlan,
  type NodeCheckPlan,
} from "../utilities/node-check-plan.js";
import type { CheckProcessOutcome, CheckReportResult } from "../utilities/check-report.js";
import { readCheckToolVersion, runCheckProcess } from "./process.js";
import { executeNodeCheckPlan } from "./recipe.js";

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
    throw new TypeError(`The ${plan.recipe} recipe requires Node ${plan.toolchain.node}.`);
  const sourcePlan = await readNodeCheckPlan(context.cwd);
  if (JSON.stringify(sourcePlan) !== JSON.stringify(plan))
    throw new TypeError("Check plan differs from repository configuration.");
  return executeNodeCheckPlan(
    sourcePlan,
    context,
    async (command, { cwd, signal, log }) => {
      if (command.kind === "install") {
        const version = await readCheckToolVersion("bun", { cwd, signal });
        signal?.throwIfAborted();
        if (version !== sourcePlan.toolchain.bun)
          throw new TypeError(`The node-check-v1 recipe requires Bun ${sourcePlan.toolchain.bun}.`);
      }
      const write = (text: string) => log.log(text);
      return runCheckProcess(command.argv, command.timeoutMs, {
        cwd,
        signal,
        stdout: write,
        stderr: write,
      });
    },
    options.dryRun
  );
}
