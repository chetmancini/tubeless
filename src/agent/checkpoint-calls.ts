import { PreparedOptions } from "../core/prepared-options.js";
import { agentError } from "./agent-state.js";
import type { SavedCall } from "./checkpoint-format.js";
import type { PreparedCall } from "./decision.js";
import type { AgentExecutionScope } from "./execution-scope.js";
import type { CompiledTool } from "./tools.js";
import type { PipelineStepContext } from "../core/pipeline-types.js";

export function saveCalls(calls: readonly PreparedCall[]): SavedCall[] {
  return calls.map((call): SavedCall => {
    const receipt = {
      id: call.id,
      tool: call.tool.name,
      replay: call.tool.replay,
      status: "pending" as const,
    };
    return call.kind === "handler"
      ? { ...receipt, kind: "handler", input: call.input }
      : {
          ...receipt,
          kind: "pipeline",
          input: call.options,
          validatedOptions: call.preparedOptions.read(
            call.tool.pipeline.optionsSchema,
            call.options
          ),
        };
  });
}

/** Reconstruct privately prepared invocations after the owning definition has matched. */
export function restoreCalls(
  saved: readonly SavedCall[],
  registry: ReadonlyMap<string, CompiledTool>,
  scope: AgentExecutionScope,
  turn: number,
  context: PipelineStepContext<object>
): PreparedCall[] {
  return saved.map((call) => {
    const tool = registry.get(call.tool);
    if (!tool || tool.kind !== call.kind)
      throw agentError("TUBELESS_AGENT_CHECKPOINT_MISMATCH", `Saved tool ${call.tool} differs`);
    const plan = tool.pipeline.plan({ dryRun: context.dryRun, cache: context.cachePolicy });
    if (!plan.ok)
      throw agentError(
        "TUBELESS_AGENT_CHECKPOINT_MISMATCH",
        `Saved tool ${call.tool} has an invalid plan`
      );
    if (tool.kind === "handler" && call.kind === "handler")
      return { kind: "handler", id: call.id, tool, input: call.input, plan };
    if (tool.kind !== "pipeline" || call.kind !== "pipeline")
      throw new Error("Saved pipeline call differs from its tool");
    const options = call.input;
    return {
      kind: "pipeline",
      id: call.id,
      tool,
      options,
      preparedOptions: PreparedOptions.restore(
        tool.pipeline.optionsSchema,
        options,
        call.validatedOptions
      ),
      scope: scope.delegate(turn, call.id),
      plan,
    };
  });
}
