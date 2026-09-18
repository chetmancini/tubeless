import type { AnyStep, StepOutput } from "./pipeline-steps.js";
import type { StepsOptions } from "./pipeline-definition.js";
import type { PipelineExecutionContext } from "./pipeline-types.js";

const REQUIRED_FINALIZER_OUTPUTS: unique symbol = Symbol("tubeless.requiredFinalizerOutputs");

export interface RequiredFinalizerMetadata<TOptions extends object> {
  readonly steps: readonly AnyStep<TOptions>[];
  compile(requiredStepIds: readonly string[]): (...args: never[]) => unknown;
}

type RequiredPipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]-?: StepOutput<S>;
};

export function requiredFinalizerMetadata<TOptions extends object>(
  finalize: object | undefined
): RequiredFinalizerMetadata<TOptions> | undefined {
  // SAFETY: `requireOutputs` stamps internal compilation metadata onto the
  // finalizer; the intersection only exposes that optional property.
  return (
    finalize as { [REQUIRED_FINALIZER_OUTPUTS]?: RequiredFinalizerMetadata<TOptions> } | undefined
  )?.[REQUIRED_FINALIZER_OUTPUTS];
}

/**
 * Build a finalizer that only runs when every listed step published an output.
 * Presence is checked by output slot, so a successfully published `undefined`
 * remains distinct from a structural skip or failure.
 */
export function requireOutputs<const TRequiredSteps extends readonly AnyStep[], TResult>(
  requiredSteps: TRequiredSteps,
  finalize: (
    outputs: RequiredPipelineOutputs<TRequiredSteps>,
    context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
  ) => TResult | Promise<TResult>
): (
  outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
  context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
) => TResult | Promise<TResult> {
  const uniqueRequiredSteps = [...new Set(requiredSteps)];
  const invoke = (
    requiredStepIds: readonly string[],
    outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
    context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
  ) => {
    const missingStepIds = requiredStepIds.filter(
      (stepId) => !Object.prototype.hasOwnProperty.call(outputs, stepId)
    );
    if (missingStepIds.length > 0) {
      throw new Error(`Required pipeline outputs missing: ${missingStepIds.join(", ")}`);
    }
    // SAFETY: every required step id was verified present above, so the partial
    // outputs contain all required keys and are a complete required-outputs map.
    return finalize(outputs as unknown as RequiredPipelineOutputs<TRequiredSteps>, context);
  };
  const requiredFinalizer = (
    outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
    context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
  ) =>
    invoke(
      uniqueRequiredSteps.map((step) => step.id),
      outputs,
      context
    );
  const metadata: RequiredFinalizerMetadata<StepsOptions<TRequiredSteps>> = Object.freeze({
    compile: (requiredStepIds: readonly string[]) => {
      const snapshot = Object.freeze([...requiredStepIds]);
      return (
        outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
        context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
      ) => invoke(snapshot, outputs, context);
    },
    steps: Object.freeze([...uniqueRequiredSteps]),
  });
  Object.defineProperty(requiredFinalizer, REQUIRED_FINALIZER_OUTPUTS, {
    value: metadata,
  });
  return requiredFinalizer;
}
