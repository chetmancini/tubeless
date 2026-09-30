import { setExecutionScope } from "../core/execution-scope.js";
import { STEP_ORCHESTRATION } from "../core/pipeline-step-metadata.js";
import { agentScope, limit } from "./execution-scope.js";
import { expectedToolFailure } from "./tool-failure.js";
import { createSteps, definePipeline, type IterationDecision } from "../core/pipeline.js";
import { invokeChildPipeline } from "../core/child-execution.js";
import { createMappedChildProgress } from "../core/child-progress.js";
import {
  PipelineExecutionError,
  isPipelineCancellation,
} from "../core/pipeline-execution-error.js";
import type { PipelineStepContext, StandardSchemaV1 } from "../core/pipeline-types.js";
import type { PreparedOptions } from "../core/prepared-options.js";
import { validateStandardSchema } from "../core/pipeline-validation.js";
import { throwIfAborted } from "../utilities/abort.js";
import { runConcurrentPartial } from "../utilities/batch.js";
import { ownState } from "./agent-state.js";
import { decisionEnvelope, prepareCalls, type PreparedCall } from "./decision.js";
import type {
  AgentDecisionContext,
  AgentLimits,
  AgentOutcome,
  AgentState,
  Output,
  Tools,
} from "./agent-types.js";
import type { RuntimeAgentDefinition } from "./compile-agent.js";
import type { CompiledTool, ToolInvocation } from "./tools.js";

export interface TurnState<State> {
  state: AgentState<State>;
  turn: number;
  stateVersion: number;
  calls: number;
}

function childInvocation(
  call: PreparedCall,
  context: PipelineStepContext<object>,
  attributes: ToolInvocation["attributes"]
): { options: object; context: PipelineStepContext<object>; preparedOptions?: PreparedOptions } {
  if (call.kind === "handler")
    return { options: { input: call.input, attributes } satisfies ToolInvocation, context };
  const childContext = { ...context };
  setExecutionScope(childContext, call.scope);
  return { options: call.options, context: childContext, preparedOptions: call.preparedOptions };
}

export function createAgentTurn<
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
>(
  definition: RuntimeAgentDefinition<string, Options, Result, State, Registry>,
  registry: ReadonlyMap<string, CompiledTool>,
  limits: Required<AgentLimits>,
  descriptors: Pick<AgentDecisionContext<Output<Options>>, "capabilities" | "resultJsonSchema">
) {
  type TurnOptions = { execution: TurnState<State>; options: Output<Options>; agentRunId: string };
  type Decision =
    | { kind: "finish"; result: Output<Result> }
    | { kind: "continue"; calls: PreparedCall[]; state: AgentState<State> };
  const { step } = createSteps<TurnOptions>();
  const decide = step("decide", {
    description: "Request and validate one decision, including the complete call batch.",
    run: async (_inputs, context): Promise<Decision> => {
      const { execution, options, agentRunId } = context.options;
      const { turn, stateVersion, state, calls } = execution;
      throwIfAborted(context.signal, "Agent decision");
      const scope = agentScope(context)!;
      scope.reserve("maxDecisions", 1, context.signal);
      const callback = context.dryRun ? definition.dryRun! : definition.decide;
      const attributes = {
        "agent.runId": agentRunId,
        "agent.turn": turn,
        "agent.stateVersion": stateVersion,
        "agent.callsAdmitted": calls,
      };
      const response = await scope.run(
        async () =>
          callback(state, {
            ...context,
            options,
            turn,
            stateVersion,
            ...descriptors,
          }),
        context.signal
      );
      throwIfAborted(context.signal, "Agent decision");
      const decision = decisionEnvelope(response.decision);
      context.reportAttempt(1, {
        ...attributes,
        "agent.decision": decision.kind,
        "agent.callCount": decision.kind === "continue" ? decision.calls.length : 0,
      });
      if (decision.kind === "finish") {
        const result = await validateStandardSchema(
          definition.resultSchema,
          decision.result,
          "Agent finish result"
        );
        throwIfAborted(context.signal, "Agent finish");
        return { kind: "finish", result };
      }
      if (turn === limits.maxTurns) limit("maxTurns", limits.maxTurns, turn, 1, agentRunId);
      scope.check("maxCalls", decision.calls.length);
      const stateAfterDecision = ownState(response.state);
      return {
        kind: "continue",
        calls: await prepareCalls(decision.calls, registry, context),
        state: stateAfterDecision,
      };
    },
  });
  const calls = step("calls", {
    dependsOn: [decide],
    description: "Dispatch validated calls and drain active work before advancing state.",
    run: async ({ decide: decision }, context): Promise<readonly AgentOutcome<Registry>[]> => {
      if (decision.kind === "finish") return [];
      const { execution, agentRunId } = context.options;
      throwIfAborted(context.signal, "Agent call admission");
      agentScope(context)!.reserve("maxCalls", decision.calls.length, context.signal);
      const admitted = execution.calls + decision.calls.length;
      context.reportAttempt(1, {
        "agent.runId": agentRunId,
        "agent.turn": execution.turn,
        "agent.callsAdmitted": admitted,
        "agent.callCount": decision.calls.length,
      });
      const progress = createMappedChildProgress(
        decision.calls.map(({ id }) => id),
        limits.maxConcurrency,
        { detailLimit: 32 },
        context.reportProgress
      );
      progress.publish();
      const partial = await runConcurrentPartial(
        decision.calls,
        { concurrency: limits.maxConcurrency, signal: context.signal },
        async (call) => {
          progress.start(call.id);
          try {
            const attributes = {
              "agent.runId": agentRunId,
              "agent.turn": execution.turn,
              "agent.callId": call.id,
              "agent.tool": call.tool.name,
              "agent.parentAttemptId": context.attemptId,
            };
            // Record the selected alias for pipeline tools as well as handlers.
            context.reportAttempt(1, attributes);
            const invocation = childInvocation(call, context, attributes);
            const result = await invokeChildPipeline(
              call.tool.pipeline,
              invocation.options,
              invocation.context,
              {
                plan: call.plan,
                hooks: progress.plan(call.id, call.plan),
                itemKey: call.id,
                preparedOptions: invocation.preparedOptions,
              }
            );
            if (result.status === "completed" && result.finalized) {
              progress.childCompleted(call.id);
              progress.complete(call.id);
              return { id: call.id, tool: call.tool.name, ok: true as const, value: result.value };
            }
            const failure = new PipelineExecutionError(result);
            const expected = !context.signal?.aborted && expectedToolFailure(result);
            if (expected) {
              progress.fail(call.id, failure, false);
              return { id: call.id, tool: call.tool.name, ok: false as const, error: expected };
            }
            throw failure;
          } catch (error) {
            progress.fail(
              call.id,
              error instanceof Error ? error : new Error(String(error)),
              isPipelineCancellation(error, context)
            );
            throw error;
          }
        }
      );
      progress.finish();
      if (!partial.ok) throw partial.failure;
      throwIfAborted(context.signal, "Agent batch");
      // SAFETY: registered names select their own input/output validators before outcomes are built.
      return partial.results as readonly AgentOutcome<Registry>[];
    },
  });
  const reduce = step("reduce", {
    dependsOn: [decide, calls],
    description: "Commit one owned state snapshot, or publish the validated finish result.",
    run: (
      { decide: decision, calls: outcomes },
      context
    ): IterationDecision<TurnState<State>, Output<Result>> => {
      if (decision.kind === "finish") return { kind: "finish", result: decision.result };
      const { execution } = context.options;
      throwIfAborted(context.signal, "Agent reduction");
      const state = definition.reduce
        ? ownState(definition.reduce(decision.state, outcomes))
        : decision.state;
      throwIfAborted(context.signal, "Agent reduction");
      context.reportAttempt(1, {
        "agent.runId": context.options.agentRunId,
        "agent.turn": execution.turn,
        "agent.stateVersion": execution.stateVersion + 1,
        "agent.callsAdmitted": execution.calls + decision.calls.length,
      });
      return {
        kind: "next",
        state: {
          state,
          turn: execution.turn + 1,
          stateVersion: execution.stateVersion + 1,
          calls: execution.calls + decision.calls.length,
        },
      };
    },
  });
  for (const step of [decide, calls, reduce])
    Object.defineProperty(step, STEP_ORCHESTRATION, { value: true });
  return definePipeline({
    id: `${definition.id}/turn`,
    steps: [decide, calls, reduce],
    finalize: reduce,
  });
}
