import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineStepContext } from "../core/pipeline.js";
import { readBoundedCheckFile } from "../node/check-files.js";
import type { CheckProcessOutcome } from "../utilities/check-report.js";
import { exactFields } from "../utilities/node-check/data.js";
import {
  acceptedFileExecution,
  decodeFileExecution,
  matchesCompletedFiles,
  type FileExecution,
} from "../utilities/node-check/file-completion.js";
import {
  NODE_CHECK_FILE_LIMITS,
  decodeNodeCheckFileInventory,
  digestNodeCheckFileInventory,
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
  planDigest: string;
  bun: string;
  expectedInventoryDigest?: string;
}
export interface VitestFileObservation {
  error: string | null;
  inventory: NodeCheckFileInventory | null;
  execution: FileExecution | null;
}

const maxObservationBytes =
  NODE_CHECK_FILE_LIMITS.listBytes * 2 + NODE_CHECK_FILE_LIMITS.files * 80 + 4096;

export async function runVitestFiles(
  command: VitestCommand,
  request: NodeCheckFileRequest,
  plan: NodeCheckPlan,
  planDigest: string,
  { cwd, log, signal }: Pick<PipelineStepContext<object>, "cwd" | "log" | "signal">,
  expectedInventoryDigest?: string
): Promise<{
  process: CheckProcessOutcome;
  inventory: NodeCheckFileInventory | null;
  inventoryDigest: string | null;
  execution: FileExecution | null;
  evidenceError?: string;
}> {
  const transport = await mkdtemp(join(tmpdir(), "tubeless-vitest-files-"));
  try {
    const input: VitestFileInput = {
      argv: command.argv,
      request,
      reportPath: command.report.path,
      version: command.report.version,
      planDigest,
      bun: plan.toolchain.bun,
      expectedInventoryDigest,
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
      const raw = exactFields(
        JSON.parse(file.content),
        ["inventory", "execution", "error"],
        "Vitest file observation"
      );
      if (raw.error !== null && typeof raw.error !== "string")
        throw new TypeError("Invalid Vitest file observation.");
      if (!raw.inventory) throw new Error(raw.error ?? "Missing Vitest file inventory.");
      const inventory = decodeNodeCheckFileInventory(raw.inventory);
      if (
        inventory.planDigest !== planDigest ||
        inventory.stepId !== request.stepId ||
        inventory.toolchain.vitest !== command.report.version ||
        inventory.toolchain.bun !== plan.toolchain.bun ||
        inventory.source.commit !== null ||
        inventory.source.treeSha !== null
      )
        throw new TypeError("Vitest observation does not match the local check context.");

      const inventoryDigest = await digestNodeCheckFileInventory(inventory);
      const expected = request.mode === "selected" ? request.files : inventory.files;
      const execution = decodeFileExecution(raw.execution);
      const discovered = new Set(inventory.files);
      if (execution)
        execution.complete =
          matchesCompletedFiles(execution, expected) &&
          expected.every((path) => discovered.has(path));
      const result = { process: processOutcome, inventory, inventoryDigest, execution };
      if (expectedInventoryDigest && inventoryDigest !== expectedInventoryDigest)
        return { ...result, evidenceError: "Vitest inventory changed after partition planning." };
      if (raw.error) return { ...result, evidenceError: raw.error };
      if (
        request.mode === "inventory" ||
        processOutcome.status !== "exited" ||
        processOutcome.exitCode !== 0 ||
        (execution && acceptedFileExecution(execution))
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
