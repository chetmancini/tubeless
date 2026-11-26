import {
  decodeNodeCheckFileRequest,
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
