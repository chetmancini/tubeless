import {
  resolveNodeCheckPlan,
  decodeNodeCheckPlan,
  type NodeCheckConfig,
  type NodeCheckPlan,
} from "tubeless/check-plan";
import { readNodeCheckPlan, runNodeCheck, type NodeCheckExecution } from "tubeless/node/check";
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
