import { invokeChildPipeline } from "../core/child-execution.js";
import {
  isPipelineCancellation,
  PipelineExecutionError,
} from "../core/pipeline-execution-error.js";
import type { PipelineHooks, PipelineStepContext } from "../core/pipeline-types.js";
import { callInvocation, type PreparedCall } from "./decision.js";
import { expectedToolFailure } from "./tool-failure.js";
import type { ToolActivity } from "./tool-progress.js";
import type { ToolInvocation } from "./tools.js";
import { agentTranscript } from "./transcript.js";

type ToolExecutionResult =
  | { readonly ok: true; readonly value: unknown; readonly label?: string }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly failure: PipelineExecutionError;
    };

/** Execute one prepared call; callers own admission, checkpointing and aggregate progress. */
export async function executePreparedToolCall(
  call: PreparedCall,
  context: PipelineStepContext<object>,
  invocation: Omit<ToolInvocation, "input" | "call" | "onActivity"> & { turn: number },
  child: { stepId: string; hooks: PipelineHooks }
): Promise<ToolExecutionResult> {
  let activity: ToolActivity | undefined;
  try {
    const prepared = callInvocation(call, context, {
      ...invocation,
      onActivity: (started) => {
        activity = started;
      },
    });
    // Code-mode calls run under a script deadline; the agent drains delivery outside it.
    void agentTranscript(context)?.record(invocation.turn, {
      kind: "call",
      id: call.id,
      tool: call.tool.name,
      input: call.kind === "handler" ? call.input : call.options,
    });
    const run = await invokeChildPipeline(call.tool.pipeline, prepared.options, prepared.context, {
      ...child,
      plan: call.plan,
      itemKey: call.id,
      preparedOptions: prepared.preparedOptions,
    });
    if (run.status === "completed" && run.finalized) {
      const label = activity?.complete(run.value);
      if (label !== undefined) context.log.log(label);
      activity = undefined;
      void agentTranscript(context)?.record(invocation.turn, {
        kind: "outcome",
        outcome: { id: call.id, tool: call.tool.name, ok: true, value: run.value },
      });
      return { ok: true, value: run.value, label };
    }
    const failure = new PipelineExecutionError(run);
    const expected = !context.signal?.aborted && expectedToolFailure(run);
    if (!expected) throw failure;
    if (activity) context.log.warn(`${activity.action}: failed`);
    activity = undefined;
    void agentTranscript(context)?.record(invocation.turn, {
      kind: "outcome",
      outcome: { id: call.id, tool: call.tool.name, ok: false, error: expected },
    });
    return { ok: false, error: expected, failure };
  } catch (error) {
    if (activity)
      context.log.warn(
        `${activity.action}: ${isPipelineCancellation(error, context) ? "cancelled" : "failed"}`
      );
    throw error;
  }
}
