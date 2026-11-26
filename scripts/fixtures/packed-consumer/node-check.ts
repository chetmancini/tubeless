import {
  decodeNodeCheckFileRequest,
  decodeNodeCheckPartitionPlan,
  digestNodeCheckPartitionPlan,
  planNodeCheckPartitions,
  verifyNodeCheckPartitionCoverage,
  digestNodeCheckFileInventory,
  digestNodeCheckFileRequest,
  resolveNodeCheckPlan,
  decodeNodeCheckPlan,
  type NodeCheckConfig,
  type NodeCheckFileRequest,
  type NodeCheckPlan,
} from "tubeless/check-plan";
import {
  readNodeCheckPlan,
  runNodeCheck,
  runNodeCheckFiles,
  runNodeCheckPartitions,
  type NodeCheckPartitionExecution,
  type NodeCheckExecution,
  type NodeCheckFileExecution,
} from "tubeless/node/check";
const config: NodeCheckConfig = {
  version: 1,
  toolchain: { node: "24", bun: "1.4.4" },
  checks: [{ id: "lint", script: "lint" }],
};
const plan: NodeCheckPlan = resolveNodeCheckPlan(config, {
  packageManager: "bun@1.4.4",
  scripts: { lint: "node --check app.js" },
});
const decoded: NodeCheckPlan | undefined = decodeNodeCheckPlan(plan);
async function check(): Promise<NodeCheckExecution> {
  return runNodeCheck(await readNodeCheckPlan("."), { cwd: "." });
}

async function checkFiles(input: NodeCheckFileRequest): Promise<NodeCheckFileExecution> {
  const request = decodeNodeCheckFileRequest(input);
  const result = await runNodeCheckFiles(await readNodeCheckPlan("."), { cwd: "." }, request);
  await digestNodeCheckFileRequest(result.fileCheck.planDigest, request);
  if (result.fileCheck.inventory) await digestNodeCheckFileInventory(result.fileCheck.inventory);
  return result;
}

async function checkPartitions(value: unknown): Promise<NodeCheckPartitionExecution> {
  const decoded = await decodeNodeCheckPartitionPlan(value);
  const partitionPlan = await planNodeCheckPartitions(decoded.inventory, decoded.request, {
    partitions: 1,
  });
  const result = await runNodeCheckPartitions(
    await readNodeCheckPlan("."),
    { cwd: "." },
    partitionPlan
  );
  await digestNodeCheckPartitionPlan(partitionPlan);
  await verifyNodeCheckPartitionCoverage(partitionPlan, result.partitionCheck.evidence);
  return result;
}
