import type { PipelineMetadata } from "../tracing/graph-metadata.js";
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

/** Preserve whether the step factory supplied a runtime options schema. */
export type StepsOptionsSchema<TSteps extends readonly AnyStep[]> =
  TSteps[number] extends Step<string, unknown, object, object, unknown, infer TSchema>
    ? TSchema
    : StandardSchemaV1 | undefined;

export type StepIds<TSteps extends readonly AnyStep[]> = TSteps[number]["id"];

export type TargetIds<TTargets extends readonly AnyStep[]> = TTargets[number]["id"];

// Step types retain output and ID types, but erase their dependency graph.
// Any declared step may therefore be last in the runtime topological order.
type DefaultStepOutput<TSteps extends readonly AnyStep[]> = TSteps extends readonly []
  ? undefined
  : StepOutput<TSteps[number]>;

export type DefaultPipelineResult<TSteps extends readonly AnyStep[]> =
  | DefaultStepOutput<TSteps>
  | undefined;

export type DefaultPipelineTargets<TSteps extends readonly AnyStep[]> = readonly TSteps[number][];

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

type PipelineFinalizerSource<
  TSteps extends readonly AnyStep[],
  TResult,
  TResultSchema extends StandardSchemaV1 | undefined,
> =
  | PipelineFinalizer<TSteps, TResult, TResultSchema>
  | (TSteps[number] &
      Step<
        string,
        TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult,
        StepsOptions<TSteps>,
        StepsInputOptions<TSteps>,
        unknown
      >);

/**
 * Declarative configuration for compiling a typed pipeline.
 *
 * A pipeline may omit finalize when its final step in execution order supplies the result.
 * Set finalize to a declared step to require and return its precisely typed output.
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
  /** Optional display name; stable identity remains `id`. */
  name?: string;
  /** Human-readable purpose shown by command and discovery surfaces. */
  description?: string;
  /** Inert, bounded JSON metadata, snapshotted during compilation. */
  metadata?: PipelineMetadata;
  /** Author- or build-supplied version of handlers, mappings, schemas, and finalizer (1–256 characters). */
  implementationVersion?: string;
  steps: TSteps;
  /** Selectable public goals; omitted exposes the last step in execution order.
   * This declaration never filters a run. Use `[]` to expose no goals.
   */
  targets?: TTargets;
  /** Optional Standard Schema for the finalized result. */
  resultSchema?: TResultSchema;
} & (TResultSchema extends StandardSchemaV1
  ? [DefaultStepOutput<TSteps>] extends [InferSchemaInput<TResultSchema>]
    ? { finalize?: PipelineFinalizerSource<TSteps, TResult, TResultSchema> }
    : { finalize: PipelineFinalizerSource<TSteps, TResult, TResultSchema> }
  : [DefaultPipelineResult<TSteps>] extends [TResult]
    ? { finalize?: PipelineFinalizerSource<TSteps, TResult, TResultSchema> }
    : { finalize: PipelineFinalizerSource<TSteps, TResult, TResultSchema> });
