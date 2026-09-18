import { compileDefinitionSnapshot } from "./pipeline-definition-identity.js";
import type { PipelineDefinition, StepsOptions } from "./pipeline-definition.js";
import { validatePipelineDefinition } from "./pipeline-definition-validation.js";
import { PipelineDefinitionError } from "./pipeline-errors.js";
import { requiredFinalizerMetadata } from "./pipeline-finalizer.js";
import { compilePipelineGraph, type CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import { STEP_OPTIONS_SCHEMA } from "./pipeline-step-metadata.js";
import type { PipelineDefinitionSnapshot, StandardSchemaV1 } from "./pipeline-types.js";

export interface CompiledPipeline<
  TSteps extends readonly AnyStep[] = readonly AnyStep[],
  TResult = unknown,
  TTargets extends readonly TSteps[number][] = readonly [],
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
  readonly definition: PipelineDefinitionSnapshot;
  readonly declaredTargets: readonly AnyStep<StepsOptions<TSteps>>[];
  readonly finalize: NonNullable<
    PipelineDefinition<TSteps, TResult, TTargets, TResultSchema>["finalize"]
  >;
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
  const compiledTargets = definition.targets
    ? definition.targets.map((target) => compiledByAuthorStep.get(target)!)
    : orderedSteps.slice(-1);
  const compiledRequiredFinalizerSteps = requiredFinalizerSteps?.map((step) =>
    compiledByAuthorStep.get(step)!
  );
  const lastStepId = orderedSteps.at(-1)?.id;
  const authoredFinalize = definition.finalize;
  type Finalizer = CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>["finalize"];
  const compiledFinalize = finalizerMetadata
    ? finalizerMetadata.compile(compiledRequiredFinalizerSteps!.map((step) => step.id))
    : authoredFinalize
      ? (outputs: Parameters<Finalizer>[0], context: Parameters<Finalizer>[1]) =>
          authoredFinalize.call(definition, outputs, context)
      : (outputs: Record<string, unknown>) =>
          lastStepId !== undefined && Object.hasOwn(outputs, lastStepId)
            ? outputs[lastStepId]
            : undefined;
  const snapshot = compileDefinitionSnapshot({
    orderedSteps,
    stepGraph,
    targetIds: compiledTargets.map((step) => step.id),
    requiredFinalizerSteps: compiledRequiredFinalizerSteps,
    resultValidated: definition.resultSchema !== undefined,
    implementationVersion: definition.implementationVersion,
  });
  return Object.freeze({
    definition: snapshot,
    declaredTargets: Object.freeze(compiledTargets),
    // Invoke ordinary finalizers on the author's definition so method-style
    // implementations keep `this`. Required finalizers compile the same input
    // and context contract with stable required ids.
    // SAFETY: supplied finalizers preserve their signature; definePipeline checks
    // that an omitted finalizer can use the last step's output as its result.
    finalize: compiledFinalize as Finalizer,
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
