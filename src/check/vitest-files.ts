import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineStepContext } from "../core/pipeline.js";
import { readBoundedCheckFile } from "../node/check-files.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import type { CheckProcessOutcome } from "../utilities/check-report.js";
import {
  NODE_CHECK_FILE_LIMITS,
  digestNodeCheckFileInventory,
  isNodeCheckFilePath,
  normalizeNodeCheckFiles,
  type NodeCheckFileCompletion,
  type NodeCheckFileInventory,
  type NodeCheckFileRequest,
} from "../utilities/node-check/files.js";
import type { NodeCheckCommand, NodeCheckPlan } from "../utilities/node-check-plan.js";
import { runCheckProcess } from "./process.js";

type VitestCommand = Extract<NodeCheckCommand, { kind: "vitest" }>;

export interface VitestFileInput {
  argv: string[];
  request: NodeCheckFileRequest;
  reportPath: string;
  version: string;
}
export interface VitestFileObservation {
  error: string | null;
  inventory:
    | (Pick<NodeCheckFileInventory, "files" | "configuration"> & {
        lockfileDigest: string;
        node: string;
        vitest: string;
      })
    | null;
  execution: { complete: boolean; files: NodeCheckFileCompletion[] } | null;
}

const maxObservationBytes =
  NODE_CHECK_FILE_LIMITS.listBytes * 2 + NODE_CHECK_FILE_LIMITS.files * 80 + 4096;
const digest = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function readObservation(content: string, command: VitestCommand): VitestFileObservation {
  const value: unknown = JSON.parse(content);
  if (!isJsonObject(value) || (value.error !== null && typeof value.error !== "string"))
    throw new TypeError("Invalid Vitest file observation.");
  const { error } = value;
  if (value.inventory === null && value.execution === null && error)
    return { error, inventory: null, execution: null };
  if (!isJsonObject(value.inventory)) throw new TypeError("Missing Vitest file inventory.");
  const { configuration, files, node, vitest, lockfileDigest } = value.inventory;
  if (
    typeof node !== "string" ||
    !/^24\.[0-9]+\.[0-9]+$/.test(node) ||
    vitest !== command.report.version ||
    typeof lockfileDigest !== "string" ||
    !digest.test(lockfileDigest)
  )
    throw new TypeError("Invalid Vitest file inventory context.");
  let primaryConfig: NodeCheckFileInventory["configuration"] = null;
  if (configuration !== null) {
    if (
      !isJsonObject(configuration) ||
      !isNodeCheckFilePath(configuration.path) ||
      typeof configuration.digest !== "string" ||
      !digest.test(configuration.digest)
    )
      throw new TypeError("Invalid Vitest configuration identity.");
    primaryConfig = { path: configuration.path, digest: configuration.digest };
  }
  const inventory = {
    files: normalizeNodeCheckFiles(files),
    configuration: primaryConfig,
    node,
    vitest,
    lockfileDigest,
  };
  if (value.execution === null) return { error, inventory, execution: null };
  if (
    !isJsonObject(value.execution) ||
    typeof value.execution.complete !== "boolean" ||
    !Array.isArray(value.execution.files) ||
    value.execution.files.length > NODE_CHECK_FILE_LIMITS.files
  )
    throw new TypeError("Invalid Vitest file execution evidence.");
  const completed = Array.from(value.execution.files, (file: unknown): NodeCheckFileCompletion => {
    if (!isJsonObject(file)) throw new TypeError("Invalid Vitest file completion.");
    const { path, state, durationMs } = file;
    if (
      !isNodeCheckFilePath(path) ||
      (state !== "passed" && state !== "failed" && state !== "skipped") ||
      (durationMs !== null &&
        (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0))
    )
      throw new TypeError("Invalid Vitest file completion.");
    return { path, state, durationMs };
  });
  normalizeNodeCheckFiles(completed.map(({ path }) => path));
  completed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { error, inventory, execution: { complete: value.execution.complete, files: completed } };
}

export async function runVitestFiles(
  command: VitestCommand,
  request: NodeCheckFileRequest,
  plan: NodeCheckPlan,
  planDigest: string,
  { cwd, log, signal }: Pick<PipelineStepContext<object>, "cwd" | "log" | "signal">
): Promise<{
  process: CheckProcessOutcome;
  inventory: NodeCheckFileInventory | null;
  inventoryDigest: string | null;
  execution: VitestFileObservation["execution"];
  evidenceError?: string;
}> {
  const transport = await mkdtemp(join(tmpdir(), "tubeless-vitest-files-"));
  try {
    const input: VitestFileInput = {
      argv: command.argv,
      request,
      reportPath: command.report.path,
      version: command.report.version,
    };
    await writeFile(join(transport, "input.json"), JSON.stringify(input));
    const write = (text: string) => log.log(text);
    const processOutcome = await runCheckProcess(
      [
        command.argv[0],
        fileURLToPath(new URL("./vitest-files-runner.js", import.meta.url)),
        transport,
      ],
      command.timeoutMs,
      { cwd, signal, stdout: write, stderr: write }
    );
    const file = await readBoundedCheckFile(transport, "result.json", maxObservationBytes);
    try {
      if ("result" in file) throw new Error(`Vitest file evidence is ${file.result.state}.`);
      const observed = readObservation(file.content, command);
      if (!observed.inventory) throw new Error(observed.error ?? "Missing Vitest file inventory.");
      const { node, vitest, lockfileDigest, ...files } = observed.inventory;
      const inventory: NodeCheckFileInventory = {
        version: 1,
        complete: true,
        ...files,
        stepId: command.id,
        planDigest,
        source: { commit: null, treeSha: null, lockfileDigest },
        toolchain: {
          node,
          bun: plan.toolchain.bun,
          vitest,
          platform: process.platform,
          arch: process.arch,
        },
      };
      const expected = request.mode === "selected" ? request.files : inventory.files;
      const execution = observed.execution;
      const discovered = new Set(inventory.files);
      if (execution)
        execution.complete &&=
          expected.length > 0 &&
          expected.length === execution.files.length &&
          execution.files.every(
            ({ path }, index) => path === expected[index] && discovered.has(path)
          );
      const result = {
        process: processOutcome,
        inventory,
        inventoryDigest: await digestNodeCheckFileInventory(inventory),
        execution,
      };
      if (observed.error) return { ...result, evidenceError: observed.error };
      if (
        request.mode === "inventory" ||
        processOutcome.status !== "exited" ||
        processOutcome.exitCode !== 0 ||
        (execution?.complete &&
          execution.files.some(({ state }) => state === "passed") &&
          !execution.files.some(({ state }) => state === "failed"))
      )
        return result;
      return {
        ...result,
        evidenceError:
          "Vitest file evidence cannot establish a complete check for the requested scope.",
      };
    } catch (error) {
      return {
        process: processOutcome,
        inventory: null,
        inventoryDigest: null,
        execution: null,
        evidenceError: error instanceof Error ? error.message : "Invalid Vitest file evidence.",
      };
    }
  } finally {
    await rm(transport, { recursive: true, force: true });
  }
}
