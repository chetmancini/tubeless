import type { CheckProcessOutcome } from "../check-report.js";
import { exactFields } from "./data.js";
import {
  acceptedFileExecution,
  decodeFileExecution,
  matchesCompletedFiles,
  type FileExecution,
} from "./file-completion.js";
import { digestNodeCheckFileRequest, type NodeCheckFileRequest } from "./files.js";
import { decodeNodeCheckPartitionPlan, type NodeCheckPartitionPlan } from "./partition-plan.js";

/** One partition's launcher-observed native outcome and independent guest file completions. */
export interface NodeCheckPartitionEvidence {
  id: number;
  inventoryDigest: string | null;
  requestDigest: string;
  process: CheckProcessOutcome;
  execution: FileExecution | null;
}

export function partitionFileRequest(
  plan: NodeCheckPartitionPlan,
  partition: NodeCheckPartitionPlan["partitions"][number]
): Extract<NodeCheckFileRequest, { mode: "selected" }> {
  return {
    version: 1,
    mode: "selected",
    stepId: plan.request.stepId,
    files: partition.files.map(({ path }) => path),
  };
}

/** Verify complete, disjoint, native-success evidence for a validated plan's entire cohort. */
export async function verifyNodeCheckPartitionCoverage(
  input: NodeCheckPartitionPlan,
  evidence: unknown
): Promise<boolean> {
  try {
    const plan = await decodeNodeCheckPartitionPlan(input);
    if (!Array.isArray(evidence) || evidence.length !== plan.partitions.length) return false;
    const seen = new Set<number>();
    for (const value of evidence) {
      const { id, inventoryDigest, requestDigest, process, execution } = exactFields(
        value,
        ["id", "inventoryDigest", "requestDigest", "process", "execution"],
        "partition evidence"
      );
      if (
        typeof id !== "number" ||
        !Number.isInteger(id) ||
        id < 1 ||
        id > plan.partitions.length ||
        seen.has(id) ||
        inventoryDigest !== plan.inventoryDigest
      )
        return false;
      seen.add(id);
      const native = exactFields(
        process,
        ["status", "exitCode", "signal", "outputComplete"],
        "partition native outcome"
      );
      if (
        native.status !== "exited" ||
        native.exitCode !== 0 ||
        native.signal !== null ||
        typeof native.outputComplete !== "boolean"
      )
        return false;
      const request = partitionFileRequest(plan, plan.partitions[id - 1]);
      const observed = decodeFileExecution(execution);
      if (
        !observed ||
        !matchesCompletedFiles(observed, request.files) ||
        !acceptedFileExecution(observed)
      )
        return false;
      if (requestDigest !== (await digestNodeCheckFileRequest(plan.inventory.planDigest, request)))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
