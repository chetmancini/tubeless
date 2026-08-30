import {
  defaultPipelineContext,
  executePlannedRun,
  PipelineExecutionError,
  resolvePipelineRuntime,
  splitPipelineRunOptions,
} from "./pipeline-execute.js";
import { createRunId, RUN_MODEL_VERSION } from "./pipeline-ids.js";
import {
  PIPELINE_FINALIZE_STEP_ID,
  PipelineDefinitionError,
  requireOutputs,
  STEP_OPTIONS_SCHEMA,
  buildPipelinePlan,
  renderPipelineMermaid,
  topologicalSort,
  validatePipelineDefinition,
  type PipelineDefinition,
} from "./pipeline-plan.js";
import type { StepIds, StepsInputOptions, StepsOptions, TargetIds } from "./pipeline-plan.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  InferSchemaOutput,
  Pipeline,
  PipelineContext,
  PipelineMermaidOptions,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
  PipelineRunOptions,
  StandardSchemaV1,
} from "./pipeline-types.js";

export { createRunId, PIPELINE_FINALIZE_STEP_ID, PipelineExecutionError, RUN_MODEL_VERSION };
export { createSteps } from "./pipeline-steps.js";
export { defaultPipelineContext };
export { PipelineDefinitionError, requireOutputs };
export type {
  PipelineLogger,
  PipelineContext,
  PipelineRunControls,
  PipelineRunOptions,
  PipelineRuntime,
  PipelineExecutionContext,
  PipelineStepProgressDetailStatus,
  PipelineStepProgressDetail,
  PipelineStepProgress,
  PipelineStepContext,
  PipelineErrorPhase,
  PipelineErrorKind,
  PipelineErrorCode,
  PipelineValidationIssue,
  PipelineError,
  StandardSchemaV1,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
  StandardSchemaV1Issue,
  InferSchemaInput,
  InferSchemaOutput,
  PipelineErrorCause,
  PipelineStepCompleteReport,
  PipelineStepSkippedReport,
  PipelineStepCancelledReport,
  PipelineStepFailedReport,
  PipelineStepReport,
  PipelineStepReportStatus,
  PipelineRunStatus,
  PipelineRun,
  PipelineStepSkipReason,
  StepSkipDecision,
  PipelineStepStatus,
  PipelineStepLifecycleStatus,
  PipelineStepPlannedEvent,
  PipelineStepStartEvent,
  PipelineStepProgressEvent,
  PipelineStepCancelledEvent,
  PipelineStepFailedEvent,
  PipelineStepSkippedEvent,
  PipelineStepCompleteEvent,
  PipelineHooks,
  PipelineStepSelectionReason,
  PipelinePlanStep,
  PipelinePlan,
  PipelineMermaidDirection,
  PipelineMermaidOptions,
  Pipeline,
} from "./pipeline-types.js";

export type { PipelineDefinition } from "./pipeline-plan.js";

export type { AnyStep, Step, MappedChildProgressOptions, StepFactory } from "./pipeline-steps.js";

type DuplicateStepIds<
  TSteps extends readonly AnyStep[],
  TSeen extends string = never,
> = TSteps extends readonly [infer THead, ...infer TTail]
  ? THead extends AnyStep
    ? TTail extends readonly AnyStep[]
      ? THead["id"] extends TSeen
        ? THead["id"] | DuplicateStepIds<TTail, TSeen>
        : DuplicateStepIds<TTail, TSeen | THead["id"]>
      : never
    : never
  : never;

type CheckedStepTuple<TSteps extends readonly AnyStep[]> =
  string extends StepIds<TSteps>
    ? unknown
    : DuplicateStepIds<TSteps> extends never
      ? unknown
      : {
          /** Compile-time diagnostic: every literal step ID in a definition must be unique. */
          readonly __duplicateStepIds: DuplicateStepIds<TSteps>;
        };

export function definePipeline<
  const TSteps extends readonly AnyStep[],
  TResult = unknown,
  const TTargets extends readonly TSteps[number][] = readonly [],
  const TResultSchema extends StandardSchemaV1 | undefined = undefined,
>(
  definition: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema> &
    CheckedStepTuple<TSteps>
): Pipeline<
  StepsInputOptions<TSteps>,
  TResultSchema extends StandardSchemaV1 ? InferSchemaOutput<TResultSchema> : TResult,
  StepIds<TSteps>,
  TargetIds<TTargets>
> {
  const definitionErrors = validatePipelineDefinition(definition);
  if (definitionErrors.length > 0) {
    throw new PipelineDefinitionError(definition.id, definitionErrors);
  }
  type TOptions = StepsOptions<TSteps>;
  type TInputOptions = StepsInputOptions<TSteps>;
  type TPipelineResult = TResultSchema extends StandardSchemaV1
    ? InferSchemaOutput<TResultSchema>
    : TResult;
  type TStepId = StepIds<TSteps>;
  type TTargetId = TargetIds<TTargets>;
  // SAFETY: each step id is a string key of `TSteps`, so the frozen id list is
  // exactly the declared `TStepId` union.
  const stepIds = Object.freeze(definition.steps.map((step) => step.id)) as readonly TStepId[];
  // SAFETY: each target id is a string key of `TTargets`, so the frozen list is
  // exactly the declared `TTargetId` union.
  const targetIds = Object.freeze(
    (definition.targets ?? []).map((step) => step.id)
  ) as readonly TTargetId[];
  const optionsSchema = definition.steps[0]?.[STEP_OPTIONS_SCHEMA];
  // SAFETY: every step in `definition.steps` is an `AnyStep<TOptions>`; the
  // cast only restores the generic type parameter that the tuple lost.
  const orderedDefinitionSteps = topologicalSort(definition.steps as readonly AnyStep<TOptions>[])!;

  function plan(controls: PipelineRunControls<TStepId, TTargetId> = {}): PipelinePlan {
    return buildPipelinePlan(definition, controls);
  }

  function toMermaid(options: PipelineMermaidOptions = {}): string {
    return renderPipelineMermaid(orderedDefinitionSteps, options);
  }

  async function run(
    options: PipelineRunOptions<TInputOptions, TStepId, TTargetId>,
    context: Partial<PipelineContext> = defaultPipelineContext()
  ): Promise<PipelineRun<TPipelineResult>> {
    const { controls, domainOptions } = splitPipelineRunOptions(options);
    return executePlannedRun({
      controls,
      definition,
      domainOptions,
      optionsSchema,
      plan: plan(controls),
      runtime: resolvePipelineRuntime(context),
      targetIds,
    });
  }

  async function runOrThrow(
    options: PipelineRunOptions<TInputOptions, TStepId, TTargetId>,
    context: Partial<PipelineContext> = defaultPipelineContext()
  ): Promise<TPipelineResult> {
    const result = await run(options, context);
    if (result.status !== "completed") {
      throw new PipelineExecutionError(result);
    }
    // SAFETY: a completed run always carries its `TPipelineResult` value.
    return result.value as TPipelineResult;
  }

  return { id: definition.id, stepIds, targetIds, plan, run, runOrThrow, toMermaid };
}

export {
  formatMappedChildProgressMessage,
  mappedChildProgressDetails,
  mappedChildProgressUnits,
  toMappedChildStepProgress,
  type FormatMappedChildProgressOptions,
  type MappedChildProgressDetail,
  type MappedChildProgressSnapshot,
  type MappedChildProgressUnits,
  type ToMappedChildStepProgressOptions,
} from "./mapped-child-progress.js";
