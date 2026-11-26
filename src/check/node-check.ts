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
import { collectVitestReport, executeNodeCheckPlan, requireCheckSuccess } from "./recipe.js";
import { prepareCheckReport } from "../node/check-files.js";
import { digestCanonicalJson } from "../utilities/canonical-json.js";
import {
  decodeNodeCheckPartitionPlan,
  type NodeCheckPartitionPlan,
} from "../utilities/node-check/partition-plan.js";
import {
  partitionFileRequest,
  type NodeCheckPartitionEvidence,
} from "../utilities/node-check/partition-coverage.js";
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
    mode: request.mode === "inventory" ? "inventory" : "files",
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

/** One graph run with independent partition evidence and diagnostic reports for the selected Vitest step. */
export interface NodeCheckPartitionExecution extends NodeCheckExecution {
  partitionCheck: {
    version: 1;
    planDigest: string;
    partitionPlanDigest: string;
    inventoryDigest: string;
    request: NodeCheckPartitionPlan["request"];
    requestDigest: string;
    outcome: "not-run" | "subset-passed" | "full-passed" | "failed" | "cancelled";
    coverageComplete: boolean;
    evidence: NodeCheckPartitionEvidence[];
    reports: { id: number; result: CheckReportResult }[];
  };
}

/** Execute a validated file partition plan locally, one partition process at a time in one check graph. */
export async function runNodeCheckPartitions(
  input: NodeCheckPlan,
  context: NodeCheckContext,
  partitionPlan: NodeCheckPartitionPlan,
  options: NodeCheckOptions = {}
): Promise<NodeCheckPartitionExecution> {
  const { dryRun } = options;
  const [plan, partitions] = await Promise.all([
    verifyLocalPlan(input, context.cwd),
    decodeNodeCheckPartitionPlan(partitionPlan),
  ]);
  const planDigest = await digestNodeCheckPlan(plan);
  const { request, requestDigest, inventory, inventoryDigest } = partitions;
  if (
    planDigest !== inventory.planDigest ||
    !plan.commands.some(({ id, kind }) => id === request.stepId && kind === "vitest")
  )
    throw new TypeError("Partition plan does not match the local Node check plan.");
  if (inventory.source.commit !== null || inventory.source.treeSha !== null)
    throw new TypeError(
      "Local partition execution requires an inventory discovered from the local checkout."
    );

  const partitionCheck: NodeCheckPartitionExecution["partitionCheck"] = {
    version: 1,
    planDigest,
    partitionPlanDigest: await digestCanonicalJson(partitions),
    inventoryDigest,
    request,
    requestDigest,
    outcome: "not-run",
    coverageComplete: false,
    evidence: [],
    reports: [],
  };
  const execution = await executeNodeCheckPlan(plan, context, localRunner(plan), dryRun, {
    stepId: request.stepId,
    mode: "partitions",
    async run(command, step) {
      const deadline = performance.now() + command.timeoutMs;
      for (const partition of partitions.partitions) {
        step.signal?.throwIfAborted();
        if ((await digestNodeCheckPlan(await readNodeCheckPlan(step.cwd))) !== planDigest)
          throw new Error("Node check configuration changed after partition planning.");
        await prepareCheckReport(step.cwd, command.report.path);
        const fileRequest = partitionFileRequest(partitions, partition);
        const digest = await digestNodeCheckFileRequest(planDigest, fileRequest);
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1)
          throw new Error(`Vitest partition step ${command.id} exhausted its deadline.`);
        const observed = await runVitestFiles(
          { ...command, timeoutMs: remaining },
          fileRequest,
          plan,
          planDigest,
          step,
          inventoryDigest
        );
        partitionCheck.evidence.push({
          id: partition.id,
          requestDigest: digest,
          inventoryDigest: observed.inventoryDigest,
          process: observed.process,
          execution: observed.execution,
        });
        partitionCheck.reports.push({
          id: partition.id,
          result: await collectVitestReport(command, step, observed.process, true),
        });
        step.signal?.throwIfAborted();
        requireCheckSuccess(
          `Vitest partition ${partition.id}`,
          observed.process,
          observed.evidenceError
        );
      }
      if (performance.now() > deadline)
        throw new Error(`Vitest partition step ${command.id} exhausted its deadline.`);
      partitionCheck.coverageComplete = true;
    },
  });
  const { status } = execution.run;
  if (status === "failed" || status === "cancelled") partitionCheck.outcome = status;
  else if (status === "completed" && partitionCheck.coverageComplete)
    partitionCheck.outcome = request.mode === "full" ? "full-passed" : "subset-passed";
  return { ...execution, partitionCheck };
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
