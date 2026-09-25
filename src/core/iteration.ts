import { throwIfAborted } from "../utilities/abort.js";
import { createSingleChildRunner } from "./child-execution.js";
import { isPipelineCancellation } from "./pipeline-execution-error.js";
import type {
  Pipeline,
  PipelineExecutionContext,
  PipelineRunControls,
  PipelineStepContext,
  PipelineStepProgress,
  PipelineStepProgressDetail,
} from "./pipeline-types.js";

/** Read-only state supplied to an iteration's mapping and transition callbacks. */
export type IterationState<T> = { readonly [K in keyof T]: IterationState<T[K]> };

/** Continue with a new state or publish the iteration step's final output. */
export type IterationDecision<TState, TResult> =
  | { readonly kind: "next"; readonly state: TState; readonly result?: never }
  | { readonly kind: "finish"; readonly result: TResult; readonly state?: never };

interface IterationConfig<TOptions extends object> {
  stepId: string;
  pipeline: Pipeline<object, unknown>;
  maxIterations: number;
  controls?: PipelineRunControls;
  initialState(
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<TOptions>
  ): unknown;
  mapOptions(
    state: unknown,
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<TOptions>
  ): object;
  transition(result: unknown, state: unknown, context: PipelineExecutionContext<TOptions>): unknown;
}

function decision(value: unknown): IterationDecision<unknown, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "kind")
  ) {
    if (
      "kind" in value &&
      value.kind === "finish" &&
      Object.hasOwn(value, "result") &&
      !("state" in value)
    ) {
      return { kind: "finish", result: Reflect.get(value, "result") };
    }
    if (
      "kind" in value &&
      value.kind === "next" &&
      Object.hasOwn(value, "state") &&
      !("result" in value)
    ) {
      return { kind: "next", state: Reflect.get(value, "state") };
    }
  }
  throw Object.assign(new Error("Iteration transition must return next(state) or finish(result)"), {
    code: "TUBELESS_ITERATION_INVALID_DECISION",
  });
}

/** Repeat ordinary child execution; state and retained progress belong to this invocation. */
export function createIterationRunner<TOptions extends object>(config: IterationConfig<TOptions>) {
  return async (
    inputs: Record<string, unknown>,
    context: PipelineStepContext<TOptions>
  ): Promise<unknown> => {
    throwIfAborted(context.signal, "Pipeline iteration");
    let state = config.initialState(inputs, context);
    const retained: PipelineStepProgressDetail[][] = [];
    for (let index = 1; index <= config.maxIterations; index++) {
      throwIfAborted(context.signal, "Pipeline iteration");
      const key = `iteration-${index}`;
      let latest: PipelineStepProgress | undefined;
      const rows = (status: PipelineStepProgressDetail["status"]): PipelineStepProgressDetail[] => [
        { id: key, status, completed: latest?.completed, total: latest?.total },
        ...(latest?.details ?? []).map((row) => ({
          ...row,
          id: `${key}/${row.id}`,
          depth: (row.depth ?? 0) + 1,
        })),
      ];
      const publish = (status: PipelineStepProgressDetail["status"]): void => {
        const omitted = index - 1 - retained.length;
        context.reportProgress({
          completed: status === "completed" ? index : index - 1,
          message: `Iteration ${index} of at most ${config.maxIterations}${latest?.message ? `: ${latest.message}` : ""}`,
          details: [
            // Traces retain a prefix: keep the current group and newest history first.
            ...rows(status),
            ...retained.flat(),
            ...(omitted > 0
              ? [{ id: `${omitted} earlier iterations`, status: "completed" as const }]
              : []),
          ],
        });
      };
      publish("running");
      try {
        const runChild = createSingleChildRunner<TOptions>({
          pipeline: config.pipeline,
          controls: config.controls,
          mapOptions: () => config.mapOptions(state, inputs, context),
        });
        const value = await runChild(inputs, {
          ...context,
          tracing: context.tracing
            ? {
                ...context.tracing,
                iteration: {
                  runId: context.runId,
                  stepId: config.stepId,
                  attemptId: context.attemptId,
                  index,
                },
              }
            : undefined,
          reportProgress: (progress) => {
            latest = progress;
            publish("running");
          },
        });
        throwIfAborted(context.signal, "Pipeline iteration");
        const next = decision(await config.transition(value, state, context));
        throwIfAborted(context.signal, "Pipeline iteration");
        if (next.kind === "finish") {
          const result = await next.result;
          throwIfAborted(context.signal, "Pipeline iteration");
          publish("completed");
          return result;
        }
        if (index === config.maxIterations) {
          throw Object.assign(
            new Error(
              `Pipeline iteration reached maxIterations=${config.maxIterations} after ${config.maxIterations} child runs`
            ),
            { code: "TUBELESS_ITERATION_LIMIT_REACHED" }
          );
        }
        publish("completed");
        state = next.state;
        retained.unshift(rows("completed"));
        // Keep at most 32 iteration groups in progress; child traces retain full history.
        if (retained.length >= 32) retained.pop();
      } catch (error) {
        publish(isPipelineCancellation(error, context) ? "cancelled" : "failed");
        throw error;
      }
    }
  };
}
