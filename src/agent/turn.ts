import { createSteps, definePipeline, type IterationDecision } from "../core/pipeline.js";
import { invokeChildPipeline } from "../core/child-execution.js";
import { createMappedChildProgress } from "../core/child-progress.js";
import {
  PipelineExecutionError,
  isPipelineCancellation,
} from "../core/pipeline-execution-error.js";
import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { validateStandardSchema } from "../core/pipeline-validation.js";
import { throwIfAborted } from "../utilities/abort.js";
import { runConcurrentPartial } from "../utilities/batch.js";
import { agentError, ownState } from "./agent-state.js";
import { decisionEnvelope, prepareCalls, type PreparedCall } from "./decision.js";
import type {
  AgentDefinition,
  AgentDecisionContext,
  AgentLimits,
  AgentOutcome,
  AgentState,
  Output,
  Tools,
} from "./agent-types.js";
import type { CompiledTool, ToolInvocation } from "./tools.js";

export interface TurnState<State> {
  state: AgentState<State>;
  turn: number;
  stateVersion: number;
  calls: number;
}

export function resolvedLimits(limits: AgentLimits = {}): Required<AgentLimits> {
  const defaults = { maxTurns: 20, maxCalls: 100, maxDecisions: 100, maxConcurrency: 1 };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(defaults, key))
      throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", `Unsupported agent limit: ${key}`);
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof AgentLimits)[]) {
    const value = limits[key] === undefined ? defaults[key] : limits[key];
    if (!Number.isSafeInteger(value) || value < (key === "maxCalls" ? 0 : 1))
      throw agentError(
        "TUBELESS_AGENT_INVALID_DEFINITION",
        `Agent ${key} must be a ${key === "maxCalls" ? "nonnegative" : "positive"} safe integer`
      );
    result[key] = value;
  }
  return Object.freeze(result);
}

function limit(name: string, bound: number, consumed: number, requested: number): never {
  throw agentError(
    "TUBELESS_AGENT_LIMIT_REACHED",
    `Agent invocation ${name}=${bound} exceeded (consumed=${consumed}, requested=${requested}, scope=invocation)`
  );
}

export function createAgentTurn<
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
>(
  definition: AgentDefinition<string, Options, Result, State, Registry>,
  registry: ReadonlyMap<string, CompiledTool>,
  limits: Required<AgentLimits>,
  descriptors: Pick<AgentDecisionContext<Output<Options>>, "capabilities" | "resultJsonSchema">
) {
  type TurnOptions = { execution: TurnState<State>; options: Output<Options>; agentRunId: string };
  type Decision =
    | { kind: "finish"; result: Output<Result> }
    | { kind: "continue"; calls: PreparedCall[] };
  const { step } = createSteps<TurnOptions>();
  const decide = step("decide", {
    description: "Request and validate one decision, including the complete call batch.",
    run: async (_inputs, context): Promise<Decision> => {
      const { execution, options, agentRunId } = context.options;
      const { turn, stateVersion, state, calls } = execution;
      throwIfAborted(context.signal, "Agent decision");
      if (turn > limits.maxDecisions) limit("maxDecisions", limits.maxDecisions, turn - 1, 1);
      const callback = context.dryRun ? definition.dryRun! : definition.decide;
      const attributes = {
        "agent.runId": agentRunId,
        "agent.turn": turn,
        "agent.stateVersion": stateVersion,
        "agent.callsAdmitted": calls,
      };
      const decision = decisionEnvelope(
        await callback(state, { ...context, options, turn, stateVersion, ...descriptors })
      );
      throwIfAborted(context.signal, "Agent decision");
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
      if (turn === limits.maxTurns) limit("maxTurns", limits.maxTurns, turn, 1);
      if (decision.calls.length > limits.maxCalls - calls)
        limit("maxCalls", limits.maxCalls, calls, decision.calls.length);
      return { kind: "continue", calls: await prepareCalls(decision.calls, registry, context) };
    },
  });
  const calls = step("calls", {
    dependsOn: [decide],
    description: "Dispatch validated calls and drain active work before advancing state.",
    run: async ({ decide: decision }, context): Promise<readonly AgentOutcome<Registry>[]> => {
      if (decision.kind === "finish") return [];
      const { execution, agentRunId } = context.options;
      throwIfAborted(context.signal, "Agent call admission");
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
          const invocation: ToolInvocation = {
            input: call.input,
            attributes: {
              "agent.runId": agentRunId,
              "agent.turn": execution.turn,
              "agent.callId": call.id,
              "agent.tool": call.tool.name,
              "agent.parentAttemptId": context.attemptId,
            },
          };
          try {
            const result = await invokeChildPipeline(call.tool.pipeline, invocation, context, {
              plan: call.plan,
              hooks: progress.plan(call.id, call.plan),
              itemKey: call.id,
            });
            if (result.status === "completed" && result.finalized) {
              progress.childCompleted(call.id);
              progress.complete(call.id);
              return { id: call.id, tool: call.tool.name, ok: true as const, value: result.value };
            }
            const failure = new PipelineExecutionError(result);
            if (
              result.status === "failed" &&
              !context.signal?.aborted &&
              invocation.expectedError &&
              result.errors.length === 1 &&
              result.errors[0]!.stepId === "tool" &&
              result.errors[0]!.code === "TUBELESS_STEP_FAILED"
            ) {
              progress.fail(call.id, failure, false);
              return {
                id: call.id,
                tool: call.tool.name,
                ok: false as const,
                error: {
                  code: invocation.expectedError.code,
                  message: invocation.expectedError.message,
                },
              };
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
        ? ownState(definition.reduce(execution.state, outcomes))
        : execution.state;
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
  return definePipeline({
    id: `${definition.id}/turn`,
    steps: [decide, calls, reduce],
    finalize: reduce,
  });
}
