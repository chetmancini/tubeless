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

type PipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]: StepOutput<S>;
};

export interface PipelineDefinition<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][] = readonly [],
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
  id: string;
  steps: TSteps;
  /** Public downstream goals that callers may select with `targets`. */
  targets?: TTargets;
  /** Optional Standard Schema for the finalized result. */
  resultSchema?: TResultSchema;
  finalize(
    outputs: Partial<PipelineOutputs<TSteps>>,
    context: PipelineExecutionContext<StepsOptions<TSteps>>
  ):
    | (TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult)
    | Promise<TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult>;
}
