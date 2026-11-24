import type { PipelineContext } from "../core/pipeline.js";
import type { NodeCheckPlan } from "../utilities/node-check-plan.js";
import { executeNodeCheck, type NodeCheckExecution } from "./recipe.js";

export { readNodeCheckPlan, type NodeCheckExecution } from "./recipe.js";

/** Execute an admitted plan with the ordinary Tubeless scheduler. All checks run unless fail-fast or cancellation stops them. */
export async function runNodeCheck(
  input: NodeCheckPlan,
  context: Partial<PipelineContext> & { cwd: string },
  options: { dryRun?: boolean } = {}
): Promise<NodeCheckExecution> {
  return executeNodeCheck(input, context, options);
}
