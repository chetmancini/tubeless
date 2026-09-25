import { abortableSleep, throwIfAborted as throwIfSignalAborted } from "../utilities/abort.js";
import { createPipelineLifecycleObserver } from "./lifecycle.js";
import { createRunId } from "./pipeline-ids.js";
import type { CompiledPipeline } from "./pipeline-compiler.js";
import type { StepsOptions } from "./pipeline-definition.js";
import { decideStepDisposition } from "./pipeline-disposition.js";
import { schedulePipelineSteps } from "./pipeline-scheduler.js";
import { compiledStepGraph } from "./pipeline-graph.js";
import { planStepById, stepToPlanStep } from "./pipeline-plan.js";
import { PipelineRunState, type PipelineStepAttempt } from "./pipeline-run-state.js";
import type { AnyStep } from "./pipeline-steps.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import {
  evaluateStepSkip,
  executeStepAttempt,
  validateStepOutput,
} from "./pipeline-step-executor.js";
import type {
  InferSchemaOutput,
  PipelineContext,
  PipelineError,
  PipelineExecutionContext,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineRunControls,
  PipelineRuntime,
  StandardSchemaV1,
} from "./pipeline-types.js";
import { PipelineBoundaryValidationError, validateStandardSchema } from "./pipeline-validation.js";
import {
  finalizationError,
  stepExecutionError,
  toPipelineError,
} from "./pipeline-execution-error.js";

type PipelineRunIdentity = { correlationId?: string; parentRunId?: string; runId: string };

function throwIfAborted(runtime: PipelineRuntime): void {
  throwIfSignalAborted(runtime.signal, "Pipeline run");
}

export async function executePlannedRun<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(input: {
  compiled: CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>;
  controls: PipelineRunControls;
  domainOptions: object;
  plan: PipelinePlan;
  runtime: PipelineRuntime;
}): Promise<
  PipelineRun<TResultSchema extends StandardSchemaV1 ? InferSchemaOutput<TResultSchema> : TResult>
> {
  type TPipelineResult = TResultSchema extends StandardSchemaV1
    ? InferSchemaOutput<TResultSchema>
    : TResult;
  type TOptions = StepsOptions<TSteps>;
  const { compiled, controls, runtime } = input;
  const startedAtMs = runtime.now();
  const runId = createRunId(compiled.id);
  const correlationId = runtime.correlationId;
  const identity: PipelineRunIdentity = { runId };
  if (correlationId !== undefined) identity.correlationId = correlationId;
  if (runtime.parentRunId) identity.parentRunId = runtime.parentRunId;
  const dryRun = controls.dryRun === true;
  const lifecycle = createPipelineLifecycleObserver(compiled.id, runtime, {
    ...identity,
    itemKey: runtime.tracing?.itemKey,
  });
  const state = new PipelineRunState<TPipelineResult>(
    compiled.id,
    dryRun,
    startedAtMs,
    identity,
    runtime.now,
    lifecycle
  );
  state.start(input.plan, compiled.targetIds);

  if (!input.plan.ok) {
    state.recordRunErrors(input.plan.errors);
    return state.finish();
  }

  const maxConcurrency = controls.maxConcurrency ?? 1;

  // SAFETY: `domainOptions` is the user-supplied options object; if a schema
  // is present it is re-validated below before assignment to `pipelineOptions`.
  let pipelineOptions = input.domainOptions as TOptions;
  if (compiled.optionsSchema) {
    try {
      const validated = await validateStandardSchema(
        compiled.optionsSchema,
        input.domainOptions,
        `Pipeline ${compiled.id} options`
      );
      if (typeof validated !== "object" || validated === null || Array.isArray(validated)) {
        throw new PipelineBoundaryValidationError(
          `Pipeline ${compiled.id} options schema returned a non-object value`,
          [{ message: "Expected the validated options value to be an object" }]
        );
      }
      // SAFETY: the schema validated the value against `TOptions` and the
      // object-shape check above passed, so the value is a `TOptions`.
      pipelineOptions = validated as TOptions;
    } catch (error) {
      state.recordRunErrors([
        toPipelineError(error, {
          code: "TUBELESS_OPTIONS_VALIDATION_FAILED",
          kind: "validation",
          phase: "execution",
        }),
      ]);
      return state.finish();
    }
  }

  for (const step of input.plan.steps) state.planStep(step);

  const executionContext: PipelineExecutionContext<TOptions> = {
    ...runtime,
    dryRun,
    log: lifecycle.logger(),
    options: pipelineOptions,
    runId,
    trace: lifecycle.traceContext,
  };

  const plannedSteps = planStepById(input.plan);
  const stepsById = new Map(compiled.orderedSteps.map((step) => [step.id, step]));
  // `input.plan.steps` is already topologically ordered. Rehydrate from the original step
  // objects so callers still get the typed handlers rather than plan metadata.
  // SAFETY: every planned step id originates from `compiled.orderedSteps`, so the
  // map lookup always finds the matching `AnyStep<TOptions>`.
  const orderedSteps = input.plan.steps.map((step) => stepsById.get(step.id) as AnyStep<TOptions>);
  const plannedStepFor = (step: AnyStep<TOptions>): PipelinePlanStep =>
    plannedSteps.get(step.id) ??
    stepToPlanStep(step, true, undefined, undefined, compiledStepGraph(compiled, step));

  let stopError: PipelineError | undefined;
  let externalCancellationError: PipelineError | undefined;

  const recordUnstartedStep = (step: AnyStep<TOptions>, error: PipelineError): void => {
    const plannedStep = plannedStepFor(step);
    // Only the external signal can override a selected step's planned skip.
    if (plannedStep.skipReason && (!plannedStep.selected || error !== externalCancellationError)) {
      const dependencyId =
        plannedStep.skipReason === "unmet-dependency"
          ? plannedStep.dependencies.find((id) => plannedSteps.get(id)?.skipReason !== undefined)
          : undefined;
      state.skipStep(plannedStep, { reason: plannedStep.skipReason, dependencyId });
    } else if (error.kind === "cancellation") {
      state.cancelStep(plannedStep, { ...error, stepId: step.id }, false);
    } else {
      state.skipStep(plannedStep, {
        reason: "fail-fast",
        message: `Not run because fail-fast stopped after ${error.stepId} failed.`,
        dependencyId: error.stepId,
      });
    }
  };

  const recordExternalCancellation = (stepId: string): PipelineError | undefined => {
    if (externalCancellationError) return externalCancellationError;
    try {
      throwIfAborted(runtime);
      return undefined;
    } catch (error) {
      externalCancellationError = toPipelineError(error, {
        code: "TUBELESS_RUN_CANCELLED",
        kind: "cancellation",
        phase: "execution",
        stepId,
      });
      state.recordRunErrors([externalCancellationError]);
      return externalCancellationError;
    }
  };

  const cancelBeforeStepStart = (step: AnyStep<TOptions>): boolean => {
    const pipelineError = recordExternalCancellation(step.id);
    if (!pipelineError) return false;
    stopError ??= pipelineError;
    recordUnstartedStep(step, pipelineError);
    return true;
  };

  const recordStepExecutionFailure = (
    error: unknown,
    plannedStep: PipelinePlanStep,
    attempt: PipelineStepAttempt
  ): void => {
    const pipelineError = stepExecutionError(error, runtime, plannedStep.id);
    state.failStep(plannedStep, attempt, pipelineError);
    if (!controls.continueOnError) stopError ??= pipelineError;
  };

  const recordPolicySkip = async (
    plannedStep: PipelinePlanStep,
    step: AnyStep<TOptions>,
    reason: string,
    value: unknown
  ): Promise<void> => {
    let attempt: PipelineStepAttempt | undefined;
    let published = value;
    if (step.outputSchema) {
      attempt = state.beginAttempt(plannedStep);
      try {
        published = await validateStepOutput(
          step,
          value,
          `Pipeline ${compiled.id} step ${step.id} output`
        );
      } catch (error) {
        return recordStepExecutionFailure(error, plannedStep, attempt);
      }
    }
    state.skipStep(plannedStep, {
      attempt,
      message: reason,
      output: { value: published },
      reason: "policy",
    });
  };

  const executeOneStep = async (step: AnyStep<TOptions>): Promise<void> => {
    const plannedStep = plannedStepFor(step);
    if (cancelBeforeStepStart(step)) return;

    const graph = compiledStepGraph(compiled, step);
    const disposition = decideStepDisposition({
      dryRun,
      graph,
      planned: plannedStep,
      reportsByStepId: state.reportsByStepId,
      step,
    });
    if (disposition.kind === "skip") {
      state.skipStep(plannedStep, disposition);
      return;
    }

    const inputEntries: Array<[string, unknown]> = [];
    for (const dep of graph.dependsOn) inputEntries.push([dep.id, state.outputs.get(dep.id)]);
    for (const dep of graph.optionalDependsOn) {
      if (state.outputs.has(dep.id)) inputEntries.push([dep.id, state.outputs.get(dep.id)]);
    }
    const stepInputs = Object.fromEntries(inputEntries);

    if (typeof step.skip === "function") {
      let skipDecision;
      try {
        skipDecision = await evaluateStepSkip(step, stepInputs, {
          ...executionContext,
          log: lifecycle.logger(step.id),
        });
      } catch (error) {
        const attempt = state.beginAttempt(plannedStep);
        recordStepExecutionFailure(error, plannedStep, attempt);
        return;
      }
      if (cancelBeforeStepStart(step)) return;
      if (skipDecision) {
        await recordPolicySkip(plannedStep, step, skipDecision.reason, skipDecision.value);
        return;
      }
    }

    const attempt = state.beginAttempt(plannedStep);
    try {
      const output = await executeStepAttempt({
        attemptId: attempt.attemptId,
        context: executionContext,
        dryRun,
        inputs: stepInputs,
        log: lifecycle.logger(step.id, attempt.attemptId),
        onProgress: (progress) => state.reportProgress(plannedStep, attempt, progress),
        onReportAttempt: (number, attributes) =>
          lifecycle.reportAttempt(step.id, number, attributes, attempt.attemptId),
        outputBoundary: `Pipeline ${compiled.id} step ${step.id} output`,
        step,
      });
      state.completeStep(plannedStep, attempt, output);
    } catch (error) {
      recordStepExecutionFailure(error, plannedStep, attempt);
    }
  };

  const unstarted = await schedulePipelineSteps({
    orderedSteps,
    stepGraph: compiled.stepGraph,
    maxConcurrency,
    executeOneStep,
    shouldStop: () => stopError !== undefined || runtime.signal?.aborted === true,
  });
  if (unstarted.length > 0 && runtime.signal?.aborted) {
    // An external abort takes precedence for work that never started, even
    // when an earlier failure stopped dispatch. Keep every active step's outcome.
    // Only reuse diagnostics created from this signal, never a step-local AbortError.
    stopError = recordExternalCancellation(unstarted[0]!.id)!;
  }
  for (const step of unstarted) recordUnstartedStep(step, stopError!);

  if (state.errors.length === 0 || controls.continueOnError) {
    const finalizeStartedAt = runtime.now();
    state.beginFinalization();
    try {
      throwIfAborted(runtime);
      // SAFETY: `state.outputs` maps step ids to their produced values, which is
      // exactly the shape the finalizer's outputs parameter describes.
      const finalOutputs = Object.fromEntries(state.outputs) as Parameters<
        CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>["finalize"]
      >[0];
      const finalizedValue = await compiled.finalize(finalOutputs, {
        ...executionContext,
        log: lifecycle.logger(PIPELINE_FINALIZE_STEP_ID),
      });
      // SAFETY: with a result schema the value is validated against
      // `TPipelineResult`; without one the finalizer's declared return type
      // is `TPipelineResult`, so the cast only restores that type.
      const value = compiled.resultSchema
        ? ((await validateStandardSchema(
            compiled.resultSchema,
            finalizedValue,
            `Pipeline ${compiled.id} final result`
          )) as TPipelineResult)
        : (finalizedValue as TPipelineResult);
      state.completeFinalization(value, runtime.now() - finalizeStartedAt);
    } catch (error) {
      const pipelineError = finalizationError(error, runtime);
      state.failFinalization(pipelineError, runtime.now() - finalizeStartedAt);
    }
  }

  return state.finish();
}

const fallbackNow = (): number => Date.now();

const fallbackSleep = (durationMs: number, signal?: AbortSignal): Promise<void> =>
  abortableSleep(durationMs, signal, "Pipeline sleep");

export function defaultPipelineContext(): PipelineContext {
  return { cwd: process.cwd(), log: console, now: fallbackNow, sleep: fallbackSleep };
}

export function resolvePipelineRuntime(context: Partial<PipelineContext> = {}): PipelineRuntime {
  const defaults = defaultPipelineContext();
  return {
    ...defaults,
    ...context,
    cwd: context.cwd ?? defaults.cwd,
    log: context.log ?? defaults.log,
    now: context.now ?? defaults.now ?? fallbackNow,
    sleep: context.sleep ?? defaults.sleep ?? fallbackSleep,
  };
}
