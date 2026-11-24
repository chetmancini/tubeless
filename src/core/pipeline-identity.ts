import type { PreparedOptions } from "./prepared-options.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  Pipeline,
  PipelineContext,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
} from "./pipeline-types.js";

type PipelineInvocation<
  TOptions extends object,
  TStepId extends string,
  TTargetId extends string,
> = {
  options: TOptions;
  controls: PipelineRunControls<TStepId, TTargetId>;
  context: Partial<PipelineContext>;
};

export type CompiledRunInvocation<
  TOptions extends object,
  TStepId extends string,
  TTargetId extends string,
> = PipelineInvocation<TOptions, TStepId, TTargetId> & {
  plan: PipelinePlan;
  preparedOptions?: PreparedOptions;
};

type CompiledPipelineOperations<
  TOptions extends object,
  TResult,
  TStepId extends string,
  TTargetId extends string,
> = {
  run(input: CompiledRunInvocation<TOptions, TStepId, TTargetId>): Promise<PipelineRun<TResult>>;
  runWithOverrides(
    input: PipelineInvocation<TOptions, TStepId, TTargetId> & {
      overrides: ReadonlyMap<AnyStep, unknown>;
    }
  ): Promise<PipelineRun<TResult>>;
};

const compiledPipelines = new WeakMap<object, unknown>();

/** Register execution operations on the exact object returned by `definePipeline`. */
export function registerCompiledPipeline<
  TOptions extends object,
  TResult,
  TStepId extends string,
  TTargetId extends string,
>(
  pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
  operations: CompiledPipelineOperations<
    NoInfer<TOptions>,
    NoInfer<TResult>,
    NoInfer<TStepId>,
    NoInfer<TTargetId>
  >
): void {
  compiledPipelines.set(pipeline, operations);
}

export function compiledPipelineOperations<
  TOptions extends object,
  TResult,
  TStepId extends string,
  TTargetId extends string,
>(pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>) {
  // SAFETY: registration couples the operations to the same pipeline's types.
  return compiledPipelines.get(pipeline) as
    | CompiledPipelineOperations<TOptions, TResult, TStepId, TTargetId>
    | undefined;
}

/** True only for the object `definePipeline` returned, not `Object.create` wrappers. */
export function isCompiledPipeline(pipeline: object): boolean {
  return compiledPipelines.has(pipeline);
}
