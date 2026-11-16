import { type PreparedOptions, validatePipelineOptions } from "./prepared-options.js";
import { abortableSleep, throwIfAborted as throwIfSignalAborted } from "../utilities/abort.js";
import { createPipelineLifecycleObserver } from "./lifecycle.js";
import { createRunId } from "./pipeline-ids.js";
import {
  bindExecutionJournal,
  bindJournalInput,
  executeWithJournal,
  executionJournalRuntime,
  journalFailure,
} from "./execution-journal.js";
import type { CompiledPipeline } from "./pipeline-compiler.js";
import type { StepsOptions } from "./pipeline-definition.js";
import { decideStepDisposition } from "./pipeline-disposition.js";
import { schedulePipelineSteps } from "./pipeline-scheduler.js";
import type { CompiledStep } from "./pipeline-graph.js";
import { planStepById, stepToPlanStep } from "./pipeline-plan.js";
import { PipelineRunState, type PipelineStepAttempt } from "./pipeline-run-state.js";
import type { AnyStep } from "./pipeline-steps.js";
import { prepareStepOutput, type RunOutputObservation } from "./pipeline-output-observer.js";
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
import { validateStandardSchema } from "./pipeline-validation.js";
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
  overrides?: ReadonlyMap<AnyStep, unknown>;
  preparedOptions?: PreparedOptions;
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
  const observation: RunOutputObservation | undefined =
    !dryRun && controls.outputObserver
      ? {
          observer: controls.outputObserver,
          pipelineId: compiled.id,
          runId,
          definitionIdentity: compiled.definition.identity,
          signal: runtime.signal,
        }
      : undefined;
  const lifecycle = createPipelineLifecycleObserver(compiled.id, runtime, {
    ...identity,
    itemKey: runtime.tracing?.itemKey,
    iteration: runtime.tracing?.iteration,
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
  const journalRuntime = executionJournalRuntime(
    runtime,
    compiled.id,
    !dryRun && input.overrides === undefined
  );
  try {
    if (journalRuntime.executionJournal) {
      throwIfAborted(runtime);
      // Bind original inputs before a schema can mutate them in place.
      await bindJournalInput(
        journalRuntime,
        compiled.definition.identity,
        input.domainOptions,
        controls,
        input.plan
      );
    }
  } catch (error) {
    state.recordRunErrors([stepExecutionError(error, runtime)]);
    return state.finish();
  }

  let pipelineOptions = input.domainOptions as TOptions;
  if (compiled.optionsSchema || input.preparedOptions) {
    try {
      pipelineOptions = (
        input.preparedOptions
          ? input.preparedOptions.read(compiled.optionsSchema, input.domainOptions)
          : await validatePipelineOptions(
              compiled.optionsSchema,
              input.domainOptions,
              `Pipeline ${compiled.id} options`
            )
      ) as TOptions;
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

  try {
    if (journalRuntime.executionJournal) {
      throwIfAborted(journalRuntime);
      await bindExecutionJournal(journalRuntime, ["options"], pipelineOptions);
    }
  } catch (error) {
    state.recordRunErrors([stepExecutionError(error, runtime)]);
    return state.finish();
  }

  for (const step of input.plan.steps) state.planStep(step);

  const executionContext: PipelineExecutionContext<TOptions> = {
    ...journalRuntime,
    dryRun,
    log: lifecycle.logger(),
    options: pipelineOptions,
    cachePolicy: controls.cache,
    runId,
    trace: lifecycle.traceContext,
  };

  const plannedSteps = planStepById(input.plan);
  const stepsById = new Map(compiled.orderedSteps.map((step) => [step.id, step]));
  const orderedSteps = input.plan.steps.map(
    (step) => stepsById.get(step.id) as CompiledStep<TOptions>
  );
  const plannedStepFor = (step: CompiledStep<TOptions>): PipelinePlanStep =>
    plannedSteps.get(step.id) ?? stepToPlanStep(step, true);

  let stopError: PipelineError | undefined;
  let externalCancellationError: PipelineError | undefined;

  const recordUnstartedStep = (step: CompiledStep<TOptions>, error: PipelineError): void => {
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

  const cancelBeforeStepStart = (step: CompiledStep<TOptions>): boolean => {
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
    if (!controls.continueOnError || journalFailure(executionContext)) stopError ??= pipelineError;
  };

  const recordPolicySkip = async (
    plannedStep: PipelinePlanStep,
    step: AnyStep<TOptions>,
    reason: string,
    value: unknown
  ): Promise<void> => {
    let attempt: PipelineStepAttempt | undefined;
    let published = value;
    if (step.outputSchema) attempt = state.beginAttempt(plannedStep);
    try {
      const output = await prepareStepOutput(
        value,
        step.outputSchema
          ? (raw) => validateStepOutput(step, raw, `Pipeline ${compiled.id} step ${step.id} output`)
          : undefined,
        observation,
        { stepId: step.id, attemptId: attempt?.attemptId, origin: "policy" }
      );
      if (output.commit) await output.commit();
      published = output.value;
    } catch (error) {
      attempt ??= state.beginAttempt(plannedStep);
      return recordStepExecutionFailure(error, plannedStep, attempt);
    }
    state.skipStep(plannedStep, {
      attempt,
      message: reason,
      output: { value: published },
      reason: "policy",
    });
  };

  const executeOneStep = async (step: CompiledStep<TOptions>): Promise<void> => {
    const plannedStep = plannedStepFor(step);
    if (cancelBeforeStepStart(step)) return;

    const outputSource = controls.suppliedOutputs?.has(step.id)
      ? "supplied"
      : input.overrides?.has(step)
        ? "override"
        : undefined;
    if (plannedStep.selected && outputSource) {
      const attempt = state.beginAttempt(plannedStep, runtime.now(), outputSource);
      try {
        const output = await validateStepOutput(
          step,
          outputSource === "supplied"
            ? controls.suppliedOutputs!.get(step.id)
            : input.overrides!.get(step),
          `Pipeline ${compiled.id} step ${step.id} ${outputSource} output`
        );
        throwIfAborted(runtime);
        state.completeStep(plannedStep, attempt, output);
      } catch (error) {
        recordStepExecutionFailure(error, plannedStep, attempt);
      }
      return;
    }

    const disposition = decideStepDisposition({
      dryRun,
      selected: plannedStep.selected,
      reportsByStepId: state.reportsByStepId,
      step,
    });
    if (disposition.kind === "skip") {
      state.skipStep(plannedStep, disposition);
      return;
    }

    const inputEntries: Array<[string, unknown]> = [];
    for (const dep of step.dependsOn) inputEntries.push([dep.id, state.outputs.get(dep.id)]);
    for (const dep of step.optionalDependsOn) {
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
      const output = await executeWithJournal(step, stepInputs, executionContext, (context) =>
        executeStepAttempt({
          attemptId: attempt.attemptId,
          pipelineId: compiled.id,
          onCacheHit: () => {
            attempt.outputSource = "cache";
          },
          context,
          dryRun,
          inputs: stepInputs,
          log: lifecycle.logger(step.id, attempt.attemptId),
          onArtifact: (record, preview) =>
            lifecycle.recordArtifact(step.id, attempt.attemptId, record, preview),
          onProgress: (progress) => state.reportProgress(plannedStep, attempt, progress),
          onReportAttempt: (number, attributes) =>
            lifecycle.reportAttempt(step.id, number, attributes, attempt.attemptId),
          outputBoundary: `Pipeline ${compiled.id} step ${step.id} output`,
          observation,
          step,
        })
      );
      state.completeStep(plannedStep, attempt, output);
    } catch (error) {
      recordStepExecutionFailure(error, plannedStep, attempt);
    }
  };

  const unstarted = await schedulePipelineSteps({
    orderedSteps,
    maxConcurrency,
    executeOneStep,
    shouldStop: () =>
      stopError !== undefined ||
      runtime.signal?.aborted === true ||
      !!journalFailure(executionContext),
  });
  const fatalJournalError = journalFailure(executionContext);
  if (fatalJournalError && !stopError) {
    stopError = stepExecutionError(fatalJournalError, runtime);
    state.recordRunErrors([stopError]);
  }
  if (unstarted.length > 0 && runtime.signal?.aborted) {
    // An external abort takes precedence for work that never started, even
    // when an earlier failure stopped dispatch. Keep every active step's outcome.
    // Only reuse diagnostics created from this signal, never a step-local AbortError.
    stopError = recordExternalCancellation(unstarted[0].id)!;
  }
  for (const step of unstarted) recordUnstartedStep(step, stopError!);

  if (!fatalJournalError && (state.errors.length === 0 || controls.continueOnError)) {
    const finalizeStartedAt = runtime.now();
    state.beginFinalization();
    try {
      throwIfAborted(runtime);
      const finalOutputs = Object.fromEntries(state.outputs) as Parameters<
        CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>["finalize"]
      >[0];
      const finalizedValue = await compiled.finalize(finalOutputs, {
        ...executionContext,
        log: lifecycle.logger(PIPELINE_FINALIZE_STEP_ID),
      });
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
