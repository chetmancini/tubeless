import type { PipelineDefinition, StepsOptions } from "./pipeline-definition.js";
import { validatePipelineDefinition } from "./pipeline-definition-validation.js";
import { PipelineDefinitionError } from "./pipeline-errors.js";
import { requiredFinalizerMetadata } from "./pipeline-finalizer.js";
import { compilePipelineGraph, type CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import { STEP_OPTIONS_SCHEMA } from "./pipeline-step-metadata.js";
import type { StandardSchemaV1 } from "./pipeline-types.js";

export interface CompiledPipeline<
  TSteps extends readonly AnyStep[] = readonly AnyStep[],
  TResult = unknown,
  TTargets extends readonly TSteps[number][] = readonly [],
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
  readonly declaredTargets: readonly AnyStep<StepsOptions<TSteps>>[];
  readonly finalize: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema>["finalize"];
  readonly id: string;
  readonly optionsSchema: StandardSchemaV1 | undefined;
  readonly orderedSteps: readonly AnyStep<StepsOptions<TSteps>>[];
  readonly requiredFinalizerSteps: readonly AnyStep<StepsOptions<TSteps>>[] | undefined;
  readonly stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>;
  readonly resultSchema: TResultSchema | undefined;
  readonly stepIds: readonly string[];
  readonly targetIds: readonly string[];
}

export function compilePipeline<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(
  definition: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema>
): CompiledPipeline<TSteps, TResult, TTargets, TResultSchema> {
  const errors = validatePipelineDefinition(definition);
  if (errors.length > 0) {
    throw new PipelineDefinitionError(definition.id, errors);
  }
  type TOptions = StepsOptions<TSteps>;
  // SAFETY: `steps` is `TSteps extends readonly AnyStep[]`; the cast restores
  // the `TOptions` generic that the tuple erased, without changing the values.
  const { compiledByAuthorStep, orderedSteps, stepGraph } = compilePipelineGraph(
    definition.steps as readonly AnyStep<TOptions>[]
  );
  const finalizerMetadata = requiredFinalizerMetadata<TOptions>(definition.finalize);
  const requiredFinalizerSteps = finalizerMetadata?.steps;
  // SAFETY: targets are a subset of `TSteps[number]`, each an `AnyStep<TOptions>`.
  const declaredTargets = (definition.targets ?? []) as readonly AnyStep<TOptions>[];
  const compiledTargets = declaredTargets.map((target) => compiledByAuthorStep.get(target)!);
  const compiledRequiredFinalizerSteps = requiredFinalizerSteps?.map((step) =>
    compiledByAuthorStep.get(step)!
  );
  const compiledFinalize = finalizerMetadata
    ? finalizerMetadata.compile(compiledRequiredFinalizerSteps!.map((step) => step.id))
    : (
        outputs: Parameters<typeof definition.finalize>[0],
        context: Parameters<typeof definition.finalize>[1]
      ) => definition.finalize(outputs, context);
  return Object.freeze({
    declaredTargets: Object.freeze(compiledTargets),
    // Invoke ordinary finalizers on the author's definition so method-style
    // implementations keep `this`. Required finalizers compile the same input
    // and context contract with stable required ids.
    // SAFETY: both branches preserve `definition.finalize`'s call signature.
    finalize: compiledFinalize as typeof definition.finalize,
    id: definition.id,
    optionsSchema:
      definition.steps.length === 0
        ? undefined
        : compiledByAuthorStep.get(definition.steps[0]!)?.[STEP_OPTIONS_SCHEMA],
    orderedSteps: Object.freeze([...orderedSteps]),
    stepGraph,
    requiredFinalizerSteps: compiledRequiredFinalizerSteps
      ? Object.freeze(compiledRequiredFinalizerSteps)
      : undefined,
    resultSchema: definition.resultSchema,
    stepIds: Object.freeze(definition.steps.map((step) => compiledByAuthorStep.get(step)!.id)),
    targetIds: Object.freeze(compiledTargets.map((step) => step.id)),
  });
}
