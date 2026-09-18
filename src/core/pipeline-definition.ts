import type { AnyStep, Step, StepOutput } from "./pipeline-steps.js";
import type {
  InferSchemaInput,
  PipelineExecutionContext,
  StandardSchemaV1,
} from "./pipeline-types.js";

/**
 * Recovers the options type from the steps themselves rather than taking it as its own
 * generic parameter. A `TOptions` parameter constrained by `TSteps extends
 * readonly AnyStep<TOptions>[]` is self-referential — TypeScript can't solve that at a
 * `definePipeline(...)` call site and silently widens `TOptions` to its bare
 * `object` constraint (context.options would lose every pipeline-specific
 * field). Structuring it as "derive TOptions from TSteps" instead of "constrain TSteps by
 * TOptions" avoids the cycle, so callers never write out any of these type parameters.
 */
export type StepsOptions<TSteps extends readonly AnyStep[]> =
  TSteps[number] extends AnyStep<infer TOptions> ? TOptions : object;

export type StepsInputOptions<TSteps extends readonly AnyStep[]> =
  TSteps[number] extends Step<string, unknown, object, infer TInputOptions, infer _TRunOut>
    ? TInputOptions
    : StepsOptions<TSteps>;

export type StepIds<TSteps extends readonly AnyStep[]> = TSteps[number]["id"];

export type TargetIds<TTargets extends readonly AnyStep[]> = TTargets[number]["id"];

type LastStep<TSteps extends readonly AnyStep[]> = TSteps extends readonly [
  ...AnyStep[],
  infer TLast extends AnyStep,
]
  ? TLast
  : TSteps[number];

type LastStepOutput<TSteps extends readonly AnyStep[]> = TSteps extends readonly []
  ? undefined
  : StepOutput<LastStep<TSteps>>;

export type DefaultPipelineResult<TSteps extends readonly AnyStep[]> =
  | LastStepOutput<TSteps>
  | undefined;

export type DefaultPipelineTargets<TSteps extends readonly AnyStep[]> = TSteps extends readonly []
  ? readonly []
  : readonly LastStep<TSteps>[];

export function pipelineTargets<TSteps extends readonly AnyStep[]>(definition: {
  steps: TSteps;
  targets?: readonly TSteps[number][];
}): readonly TSteps[number][] {
  return definition.targets ?? definition.steps.slice(-1);
}

type PipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]: StepOutput<S>;
};

type PipelineFinalizer<
  TSteps extends readonly AnyStep[],
  TResult,
  TResultSchema extends StandardSchemaV1 | undefined,
> = (
  outputs: Partial<PipelineOutputs<TSteps>>,
  context: PipelineExecutionContext<StepsOptions<TSteps>>
) =>
  | (TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult)
  | Promise<TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult>;

/**
 * A pipeline may omit finalize when its last declared output supplies the result.
 * The default emits undefined if that step published no output. If its output cannot
 * satisfy an explicit result type or schema input, a compatible finalizer is required.
 */
export type PipelineDefinition<
  TSteps extends readonly AnyStep[],
  TResult = DefaultPipelineResult<TSteps>,
  TTargets extends readonly TSteps[number][] = DefaultPipelineTargets<TSteps>,
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> = {
  id: string;
  steps: TSteps;
  /** Public goals; defaults to the last declared step. Use `[]` to expose none. */
  targets?: TTargets;
  /** Optional Standard Schema for the finalized result. */
  resultSchema?: TResultSchema;
} & (TResultSchema extends StandardSchemaV1
  ? [LastStepOutput<TSteps>] extends [InferSchemaInput<TResultSchema>]
    ? { finalize?: PipelineFinalizer<TSteps, TResult, TResultSchema> }
    : { finalize: PipelineFinalizer<TSteps, TResult, TResultSchema> }
  : [DefaultPipelineResult<TSteps>] extends [TResult]
    ? { finalize?: PipelineFinalizer<TSteps, TResult, TResultSchema> }
    : { finalize: PipelineFinalizer<TSteps, TResult, TResultSchema> });
