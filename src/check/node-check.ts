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
import {
  decodeNodeCheckFileRequest,
  digestNodeCheckFileRequest,
  type NodeCheckFileCompletion,
  type NodeCheckFileInventory,
  type NodeCheckFileRequest,
} from "../utilities/node-check/files.js";
import { digestNodeCheckPlan } from "../utilities/reproduction-manifest.js";
import { runVitestFiles } from "./vitest-files.js";

type NodeCheckContext = Partial<PipelineContext> & { cwd: string };
type NodeCheckOptions = { dryRun?: boolean };

/** A file-aware result. The request mode identifies the scope of any successful check. */
export interface NodeCheckFileExecution extends NodeCheckExecution {
  fileCheck: {
    request: NodeCheckFileRequest;
    planDigest: string;
    requestDigest: string;
    outcome:
      | "not-run"
      | "inventory-complete"
      | "subset-passed"
      | "full-passed"
      | "failed"
      | "cancelled";
    inventory: NodeCheckFileInventory | null;
    inventoryDigest: string | null;
    execution: { complete: boolean; files: NodeCheckFileCompletion[] } | null;
  };
}

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
  context: NodeCheckContext,
  options: NodeCheckOptions = {}
): Promise<NodeCheckExecution> {
  const plan = await verifyLocalPlan(input, context.cwd);
  return executeNodeCheckPlan(plan, context, localRunner(plan), options.dryRun);
}

/** Explicitly authorize local discovery or file-aware execution for one admitted Vitest step. */
export async function runNodeCheckFiles(
  input: NodeCheckPlan,
  context: NodeCheckContext,
  fileRequest: NodeCheckFileRequest,
  options: NodeCheckOptions = {}
): Promise<NodeCheckFileExecution> {
  const request = decodeNodeCheckFileRequest(fileRequest);
  const plan = await verifyLocalPlan(input, context.cwd);
  if (!plan.commands.some(({ id, kind }) => id === request.stepId && kind === "vitest"))
    throw new TypeError(`No Vitest check named ${request.stepId}.`);

  const planDigest = await digestNodeCheckPlan(plan);
  const fileCheck: NodeCheckFileExecution["fileCheck"] = {
    request,
    planDigest,
    requestDigest: await digestNodeCheckFileRequest(planDigest, request),
    outcome: "not-run",
    inventory: null,
    inventoryDigest: null,
    execution: null,
  };
  const execution = await executeNodeCheckPlan(plan, context, localRunner(plan), options.dryRun, {
    stepId: request.stepId,
    inventoryOnly: request.mode === "inventory",
    async run(command, step) {
      const observation = await runVitestFiles(command, request, plan, planDigest, step);
      fileCheck.inventory = observation.inventory;
      fileCheck.inventoryDigest = observation.inventoryDigest;
      fileCheck.execution = observation.execution;
      return observation;
    },
  });
  const { status } = execution.run;
  if (status === "cancelled" || status === "failed") fileCheck.outcome = status;
  else if (status === "completed" && fileCheck.inventory) {
    if (request.mode === "inventory") fileCheck.outcome = "inventory-complete";
    else if (fileCheck.execution?.complete)
      fileCheck.outcome = request.mode === "selected" ? "subset-passed" : "full-passed";
  }
  return { ...execution, fileCheck };
}

async function verifyLocalPlan(input: NodeCheckPlan, cwd: string): Promise<NodeCheckPlan> {
  if (process.platform === "win32")
    throw new TypeError("The node-check-v1 recipe requires a POSIX host; Windows is unsupported.");
  const plan = decodeNodeCheckPlan(input);
  if (!plan) throw new TypeError("Invalid Node check plan.");
  if (process.versions.node.split(".")[0] !== plan.toolchain.node)
    throw new TypeError(`The ${plan.recipe} recipe requires Node ${plan.toolchain.node}.`);
  const sourcePlan = await readNodeCheckPlan(cwd);
  if (JSON.stringify(sourcePlan) !== JSON.stringify(plan))
    throw new TypeError("Check plan differs from repository configuration.");
  return sourcePlan;
}

function localRunner(plan: NodeCheckPlan): Parameters<typeof executeNodeCheckPlan>[2] {
  return async (command, { cwd, signal, log }) => {
    if (command.kind === "install") {
      const version = await readCheckToolVersion("bun", { cwd, signal });
      signal?.throwIfAborted();
      if (version !== plan.toolchain.bun)
        throw new TypeError(`The node-check-v1 recipe requires Bun ${plan.toolchain.bun}.`);
    }
    const write = (text: string) => log.log(text);
    return runCheckProcess(command.argv, command.timeoutMs, {
      cwd,
      signal,
      stdout: write,
      stderr: write,
    });
  };
}
