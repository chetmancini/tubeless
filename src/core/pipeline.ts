import {
  defaultPipelineContext,
  executePlannedRun,
  PipelineExecutionError,
  resolvePipelineRuntime,
} from "./pipeline-execute.js";
import { RUN_MODEL_VERSION } from "./pipeline-ids.js";
import { compilePipeline } from "./pipeline-compiler.js";
import type {
  DefaultPipelineResult,
  DefaultPipelineTargets,
  PipelineDefinition,
  StepIds,
  StepsInputOptions,
  StepsOptionsSchema,
  TargetIds,
} from "./pipeline-definition.js";
import { PipelineDefinitionError } from "./pipeline-errors.js";
import { requireOutputs } from "./pipeline-finalizer.js";
import { brandCompiledPipeline, EXECUTE_COMPILED_RUN } from "./pipeline-identity.js";
import { renderPipelineMermaid } from "./pipeline-mermaid.js";
import { buildPipelinePlan } from "./pipeline-plan.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  InferSchemaOutput,
  Pipeline,
  PipelineContext,
  PipelineDefinitionSnapshot,
  PipelineMermaidOptions,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
  StandardSchemaV1,
} from "./pipeline-types.js";

export { PipelineExecutionError, RUN_MODEL_VERSION };
export { isPipelineErrorCode, PIPELINE_ERROR_CODES } from "./pipeline-types.js";
export { createSteps } from "./pipeline-steps.js";
export { PipelineDefinitionError, requireOutputs };
export type {
  PipelineDefinitionIdentity,
  PipelineDefinitionSnapshot,
  PipelineLogger,
  PipelineContext,
  PipelineRunControls,
  PipelineRunOptions,
  PipelineExecutionContext,
  PipelineStepProgressDetailStatus,
  PipelineStepProgressDetail,
  PipelineStepProgress,
  PipelineStepContext,
  RemoteStepAdapter,
  PipelineErrorPhase,
  PipelineErrorKind,
  PipelineErrorCode,
  PipelineValidationIssue,
  PipelineError,
  PipelineFanOutDiagnostics,
  PipelineFanOutFailure,
  StandardSchemaV1,
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

export type { PipelineDefinition } from "./pipeline-definition.js";

export type { Step, MappedChildProgressOptions } from "./pipeline-steps.js";

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

function snapshotRunControls<TStepId extends string, TTargetId extends string>(
  controls: PipelineRunControls<TStepId, TTargetId>
): PipelineRunControls<TStepId, TTargetId> {
  const { continueOnError, dryRun, maxConcurrency, stepIds, targets } = controls;
  const snapshot: PipelineRunControls<TStepId, TTargetId> = {};
  if (continueOnError !== undefined) snapshot.continueOnError = continueOnError;
  if (dryRun !== undefined) snapshot.dryRun = dryRun;
  if (maxConcurrency !== undefined) snapshot.maxConcurrency = maxConcurrency;
  if (stepIds !== undefined) snapshot.stepIds = [...stepIds];
  if (targets !== undefined) snapshot.targets = [...targets];
  return snapshot;
}

/**
 * Compile a typed step graph into a validated, executable pipeline.
 * Prefer inferred type arguments to preserve the literal id. For an explicit
 * result contract, annotate the finalizer's return type; partially supplied type
 * arguments use defaults for remaining parameters, including the id's string type.
 */
export function definePipeline<
  const TSteps extends readonly AnyStep[],
  TResult = DefaultPipelineResult<TSteps>,
  const TTargets extends readonly TSteps[number][] = DefaultPipelineTargets<TSteps>,
  const TResultSchema extends StandardSchemaV1 | undefined = undefined,
  const TId extends string = string,
>(
  definition: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema> &
    CheckedStepTuple<TSteps> & { readonly id: TId }
): Pipeline<
  StepsInputOptions<TSteps>,
  TResultSchema extends StandardSchemaV1 ? InferSchemaOutput<TResultSchema> : TResult,
  StepIds<TSteps>,
  TargetIds<TTargets>,
  TId
> & {
  readonly definition: PipelineDefinitionSnapshot;
  readonly optionsSchema: StepsOptionsSchema<TSteps>;
} {
  const compiled = compilePipeline<TSteps, TResult, TTargets, TResultSchema>(definition);
  type TInputOptions = StepsInputOptions<TSteps>;
  type TPipelineResult = TResultSchema extends StandardSchemaV1
    ? InferSchemaOutput<TResultSchema>
    : TResult;
  type TStepId = StepIds<TSteps>;
  type TTargetId = TargetIds<TTargets>;
  // SAFETY: each compiled step id is a string key of `TSteps`.
  const stepIds = compiled.stepIds as readonly TStepId[];
  // SAFETY: each compiled target id is a string key of `TTargets`.
  const targetIds = compiled.targetIds as readonly TTargetId[];

  function plan(controls: PipelineRunControls<TStepId, TTargetId> = {}): PipelinePlan {
    return buildPipelinePlan(compiled, controls);
  }

  function toMermaid(options: PipelineMermaidOptions = {}): string {
    return renderPipelineMermaid(compiled.orderedSteps, options, compiled.stepGraph);
  }

  async function executeCompiled(
    runPlan: PipelinePlan,
    options: TInputOptions,
    controls: PipelineRunControls<TStepId, TTargetId>,
    context: Partial<PipelineContext> = defaultPipelineContext()
  ): Promise<PipelineRun<TPipelineResult>> {
    return executePlannedRun({
      compiled,
      controls,
      domainOptions: options,
      plan: runPlan,
      runtime: resolvePipelineRuntime(context),
    });
  }

  async function run(
    options: TInputOptions,
    controls: PipelineRunControls<TStepId, TTargetId> = {},
    context: Partial<PipelineContext> = defaultPipelineContext()
  ): Promise<PipelineRun<TPipelineResult>> {
    const runControls = snapshotRunControls(controls);
    return executeCompiled(plan(runControls), options, runControls, context);
  }

  async function runOrThrow(
    options: TInputOptions,
    controls: PipelineRunControls<TStepId, TTargetId> = {},
    context: Partial<PipelineContext> = defaultPipelineContext()
  ): Promise<TPipelineResult> {
    const result = await run(options, controls, context);
    if (result.status !== "completed") {
      throw new PipelineExecutionError(result);
    }
    // SAFETY: a completed run always carries its `TPipelineResult` value.
    return result.value as TPipelineResult;
  }

  const pipeline = {
    id: definition.id,
    ...(definition.name === undefined ? {} : { name: definition.name }),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    definition: compiled.definition,
    // SAFETY: compilation verifies that every step belongs to the same options schema.
    optionsSchema: compiled.optionsSchema as StepsOptionsSchema<TSteps> &
      (StandardSchemaV1 | undefined),
    stepIds,
    targetIds,
    plan,
    run,
    runOrThrow,
    toMermaid,
  };
  Object.defineProperty(pipeline, EXECUTE_COMPILED_RUN, { value: executeCompiled });
  brandCompiledPipeline(pipeline);
  return pipeline;
}
