import { abortableSleep, isAbortError, throwIfAborted as throwIfSignalAborted } from "./abort.js";
import { PipelineChildError } from "./child-execution.js";
import { createPipelineLifecycleObserver } from "./lifecycle.js";
import { formatPipelineError } from "./pipeline-diagnostics.js";
import { createRunId, RUN_MODEL_VERSION } from "./pipeline-ids.js";
import {
  PIPELINE_FINALIZE_STEP_ID,
  decideStepDisposition,
  planStepById,
  stepToPlanStep,
  type CompiledPipeline,
} from "./pipeline-plan.js";
import type { StepsOptions } from "./pipeline-plan.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  InferSchemaOutput,
  PipelineContext,
  PipelineError,
  PipelineErrorCause,
  PipelineExecutionContext,
  PipelineLogger,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineRunControls,
  PipelineRunStatus,
  PipelineRuntime,
  PipelineStepCancelledReport,
  PipelineStepCompleteReport,
  PipelineStepContext,
  PipelineStepFailedReport,
  PipelineStepProgress,
  PipelineStepReport,
  PipelineStepSkipReason,
  PipelineStepSkippedReport,
  PipelineStepStatus,
  PipelineValidationIssue,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
  StepSkipDecision,
} from "./pipeline-types.js";
import { createPipelineTraceEmitter } from "./tracing-internal.js";

function terminalRunStatus(errors: readonly PipelineError[]): PipelineRunStatus {
  if (errors.length === 0) return "completed";
  return errors.length > 0 && errors.every(({ kind }) => kind === "cancellation")
    ? "cancelled"
    : "failed";
}

const PIPELINE_LOGGER_BASE = Symbol("pipelineLoggerBase");

type TracedPipelineLogger = PipelineLogger & { [PIPELINE_LOGGER_BASE]?: PipelineLogger };

function basePipelineLogger(log: PipelineLogger): PipelineLogger {
  // SAFETY: `TracedPipelineLogger` only adds the optional symbol-keyed base
  // property; reading it off any `PipelineLogger` is safe because the property
  // is absent unless a tracing wrapper installed it.
  return (log as TracedPipelineLogger)[PIPELINE_LOGGER_BASE] ?? log;
}

const originalPipelineErrors = new WeakMap<PipelineError, unknown>();

function defaultExecutionErrorMessage(result: PipelineRun<unknown>): string {
  const firstError = result.errors[0];
  const disposition =
    result.errors.length > 0 && result.errors.every(({ kind }) => kind === "cancellation")
      ? "cancelled"
      : "failed";
  return firstError
    ? `Pipeline ${result.pipelineId} ${disposition}: ${formatPipelineError(firstError)}`
    : `Pipeline ${result.pipelineId} ${disposition}`;
}

function firstOriginalPipelineError(errors: readonly PipelineError[]): unknown {
  for (const error of errors) {
    if (originalPipelineErrors.has(error)) return originalPipelineErrors.get(error);
  }
  return undefined;
}

export class PipelineExecutionError extends Error {
  constructor(
    readonly result: PipelineRun<unknown>,
    message = defaultExecutionErrorMessage(result)
  ) {
    const cause = firstOriginalPipelineError(result.errors);
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineExecutionError";
  }
}

class PipelineBoundaryValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly PipelineValidationIssue[],
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineBoundaryValidationError";
  }
}

function normalizeValidationPath(
  path: StandardSchemaV1Issue["path"]
): readonly (number | string)[] | undefined {
  if (!path || path.length === 0) return undefined;
  return path.map((segment) => {
    const key = typeof segment === "object" && segment !== null ? segment.key : segment;
    return typeof key === "number" || typeof key === "string" ? key : String(key);
  });
}

function renderValidationIssue(issue: PipelineValidationIssue): string {
  const location = issue.path?.map(String).join(".");
  return location ? `${location}: ${issue.message}` : issue.message;
}

async function validateStandardSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
  boundary: string
): Promise<InferSchemaOutput<TSchema>> {
  let result: StandardSchemaV1Result<InferSchemaOutput<TSchema>>;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    throw new PipelineBoundaryValidationError(
      `${boundary} schema (${schema["~standard"].vendor}) threw while validating`,
      [],
      error
    );
  }
  if (result.issues) {
    const issues = result.issues.map((issue) => {
      const path = normalizeValidationPath(issue.path);
      const normalized: PipelineValidationIssue = { message: issue.message };
      if (path) normalized.path = path;
      return normalized;
    });
    throw new PipelineBoundaryValidationError(
      `${boundary} validation failed: ${issues.map(renderValidationIssue).join("; ")}`,
      issues
    );
  }
  return result.value;
}

const MAX_PIPELINE_CAUSE_DEPTH = 8;

function readErrorField(value: object, field: "cause" | "code" | "message" | "name"): unknown {
  try {
    // SAFETY: any object may be probed for an optional string-keyed field; a
    // getter that throws is caught below, so the cast only enables the lookup.
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function safeErrorMessage(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "Unknown thrown value";
  }
}

function normalizePipelineCause(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0
): PipelineErrorCause {
  if (depth >= MAX_PIPELINE_CAUSE_DEPTH) {
    return { message: "Cause chain truncated" };
  }
  if (typeof value !== "object" || value === null) {
    return { message: safeErrorMessage(value) };
  }
  if (seen.has(value)) {
    return { message: "Circular cause" };
  }
  seen.add(value);

  const message = readErrorField(value, "message");
  const name = readErrorField(value, "name");
  const sourceCode = readErrorField(value, "code");
  const nested = readErrorField(value, "cause");
  const cause: PipelineErrorCause = {
    message: typeof message === "string" ? message : safeErrorMessage(value),
  };
  if (typeof name === "string") cause.name = name;
  if (typeof sourceCode === "string") cause.sourceCode = sourceCode;
  if (nested !== undefined) cause.cause = normalizePipelineCause(nested, seen, depth + 1);
  return cause;
}

function normalizedNestedCause(error: unknown): PipelineErrorCause | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = readErrorField(error, "cause");
  if (cause === undefined) return undefined;
  const seen = new WeakSet<object>();
  seen.add(error);
  return normalizePipelineCause(cause, seen);
}

function toPipelineError(
  error: unknown,
  classification: Omit<PipelineError, "cause" | "message" | "sourceCode" | "stack">
): PipelineError {
  const sourceCode =
    typeof error === "object" && error !== null ? readErrorField(error, "code") : undefined;
  const cause = normalizedNestedCause(error);
  const pipelineError: PipelineError = {
    ...classification,
    message: error instanceof Error ? error.message : safeErrorMessage(error),
  };
  if (error instanceof Error && error.stack) pipelineError.stack = error.stack;
  if (typeof sourceCode === "string") pipelineError.sourceCode = sourceCode;
  if (cause) pipelineError.cause = cause;
  if (error instanceof PipelineBoundaryValidationError) pipelineError.issues = error.issues;
  originalPipelineErrors.set(pipelineError, error);
  return pipelineError;
}

export function isPipelineCancellation(error: unknown, runtime: PipelineRuntime): boolean {
  if (isAbortError(error)) return true;
  if (runtime.signal?.aborted === true && error === runtime.signal.reason) return true;
  if (error instanceof PipelineChildError) return error.cancelled;
  return error instanceof PipelineExecutionError && isCancelledResult(error.result);
}

function isCancelledResult(result: PipelineRun<unknown>): boolean {
  return result.status === "cancelled";
}

type PipelineRunIdentity = { parentRunId?: string; runId: string };

function errorRunResult<TResult>(
  runtime: PipelineRuntime,
  pipelineId: string,
  dryRun: boolean,
  startedAt: number,
  errors: PipelineError[],
  identity: PipelineRunIdentity
): PipelineRun<TResult> {
  const finishedAtMs = runtime.now();
  const result: PipelineRun<TResult> = {
    pipelineId,
    dryRun,
    errors,
    finalized: false,
    finishedAtMs,
    runId: identity.runId,
    startedAtMs: startedAt,
    status: terminalRunStatus(errors),
    steps: [],
    version: RUN_MODEL_VERSION,
  };
  if (identity.parentRunId) result.parentRunId = identity.parentRunId;
  return result;
}

function throwIfAborted(runtime: PipelineRuntime): void {
  throwIfSignalAborted(runtime.signal, "Pipeline run");
}

function recordSkip(
  step: { id: PropertyKey; name?: string; description?: string },
  stepId: string,
  reports: PipelineStepReport[],
  reportsByStepId: Map<string, PipelineStepReport>,
  reason: PipelineStepSkipReason,
  message: string | undefined,
  dependencyId: string | undefined,
  attemptId: string | undefined,
  startedAtMs: number | undefined,
  finishedAtMs: number
): PipelineStepSkippedReport {
  const report: PipelineStepSkippedReport = {
    id: stepId,
    name: step.name,
    description: step.description,
    finishedAtMs,
    reason,
    status: "skipped",
  };
  if (attemptId) report.attemptId = attemptId;
  if (startedAtMs !== undefined) report.startedAtMs = startedAtMs;
  if (dependencyId) report.dependencyId = dependencyId;
  if (message) report.message = message;
  reports.push(report);
  reportsByStepId.set(stepId, report);
  return report;
}

function normalizeStepSkipDecision(
  decision: StepSkipDecision
): { reason: string; value?: unknown } | null {
  if (decision == null || decision === false) return null;
  if (typeof decision === "string") {
    const reason = decision.trim();
    return reason.length > 0 ? { reason } : null;
  }
  if (typeof decision === "object" && typeof decision.reason === "string") {
    const reason = decision.reason.trim();
    if (reason.length === 0) return null;
    return { reason, value: decision.value };
  }
  return null;
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
  const { compiled, controls, runtime } = input;
  const optionsSchema = compiled.optionsSchema;
  const targetIds = compiled.targetIds;
  type TOptions = StepsOptions<TSteps>;
  // SAFETY: `domainOptions` is the user-supplied options object; if a schema
  // is present it is re-validated below before assignment to `pipelineOptions`.
  let pipelineOptions = input.domainOptions as TOptions;
  const startedAt = runtime.now();
  const runId = runtime.runId ?? createRunId(compiled.id);
  const parentRunId = runtime.parentRunId;
  const identity: PipelineRunIdentity = { runId };
  if (parentRunId) identity.parentRunId = parentRunId;
  const dryRun = controls.dryRun === true;
  const trace = createPipelineTraceEmitter(
    compiled.id,
    runtime.tracing,
    basePipelineLogger(runtime.log),
    {
      ...identity,
      itemKey: runtime.tracing?.itemKey,
    },
    runtime.now
  );
  const lifecycle = createPipelineLifecycleObserver(compiled.id, runtime, trace);
  const tracedLogger = (stepId?: string, attemptId?: string): PipelineLogger => {
    if (!trace) return runtime.log;
    const base = basePipelineLogger(runtime.log);
    const log: TracedPipelineLogger = {
      error: (message, ...params) => {
        lifecycle.log("error", message, params, stepId, attemptId);
        base.error(message, ...params);
      },
      log: (message, ...params) => {
        lifecycle.log("log", message, params, stepId, attemptId);
        base.log(message, ...params);
      },
      warn: (message, ...params) => {
        lifecycle.log("warn", message, params, stepId, attemptId);
        base.warn(message, ...params);
      },
    };
    log[PIPELINE_LOGGER_BASE] = base;
    return log;
  };
  let nextAttemptSequence = 0;
  const beginAttempt = (stepId: string, startedAtMs = runtime.now()) => ({
    attemptId: `${runId}:attempt:${(nextAttemptSequence += 1).toString(36)}`,
    startedAtMs,
    stepId,
  });
  const currentStepStatuses = new Map<string, PipelineStepStatus["status"]>();
  const publishStepStatus = (event: PipelineStepStatus, traceStatus = true): void => {
    const previous = currentStepStatuses.get(event.step.id);
    const valid =
      (previous === undefined && event.status === "planned") ||
      (previous === "planned" &&
        (event.status === "running" ||
          event.status === "skipped" ||
          event.status === "cancelled")) ||
      (previous === "running" &&
        (event.status === "running" ||
          event.status === "completed" ||
          event.status === "skipped" ||
          event.status === "cancelled" ||
          event.status === "failed"));
    if (!valid) {
      throw new Error(
        `Invalid step status transition for ${event.step.id}: ${previous ?? "unobserved"} -> ${event.status}`
      );
    }
    currentStepStatuses.set(event.step.id, event.status);
    lifecycle.stepStatus(event, traceStatus);
  };
  const publishStepReport = (step: PipelinePlanStep, report: PipelineStepReport): void => {
    switch (report.status) {
      case "cancelled":
      case "failed":
      case "skipped":
      case "completed":
        publishStepStatus({ ...report, pipelineId: compiled.id, step });
    }
  };
  const runPlan = input.plan;
  const plannedSteps = planStepById(runPlan);
  lifecycle.pipelineStart(runPlan, targetIds);
  if (!runPlan.ok) {
    const result = errorRunResult<TPipelineResult>(
      runtime,
      compiled.id,
      dryRun,
      startedAt,
      runPlan.errors,
      identity
    );
    lifecycle.pipelineComplete(result);
    await lifecycle.flush();
    return result;
  }
  if (optionsSchema) {
    try {
      const validated = await validateStandardSchema(
        optionsSchema,
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
      const pipelineError = toPipelineError(error, {
        code: "TUBELESS_OPTIONS_VALIDATION_FAILED",
        kind: "validation",
        phase: "execution",
      });
      const result = errorRunResult<TPipelineResult>(
        runtime,
        compiled.id,
        dryRun,
        startedAt,
        [pipelineError],
        identity
      );
      lifecycle.pipelineComplete(result);
      await lifecycle.flush();
      return result;
    }
  }
  for (const step of runPlan.steps) {
    publishStepStatus({ pipelineId: compiled.id, status: "planned", step });
  }

  const outputs = new Map<string, unknown>();
  const reports: PipelineStepReport[] = [];
  const errors: PipelineError[] = [];
  const reportsByStepId = new Map<string, PipelineStepReport>();
  let completed = true;

  const executionContext: PipelineExecutionContext<TOptions> = {
    ...runtime,
    dryRun,
    log: tracedLogger(),
    options: pipelineOptions,
    runId,
    trace: trace?.context,
  };
  if (parentRunId) executionContext.parentRunId = parentRunId;

  const stepsById = new Map(compiled.orderedSteps.map((step) => [step.id, step]));
  // `runPlan.steps` is already topologically ordered. Rehydrate from the original step
  // objects so callers still get the typed `run` functions rather than plan metadata.
  // SAFETY: every planned step id originates from `compiled.orderedSteps`, so the
  // map lookup always finds the matching `AnyStep<TOptions>`.
  const orderedSteps = runPlan.steps.map((step) => stepsById.get(step.id) as AnyStep<TOptions>);

  const recordRemainingStates = (
    fromIndex: number,
    failedStepId?: string,
    cancellationError?: PipelineError
  ): void => {
    for (let index = fromIndex; index < orderedSteps.length; index++) {
      const step = orderedSteps[index]!;
      const plannedStep = plannedSteps.get(step.id) ?? stepToPlanStep(step, true);
      if (plannedStep.skipReason) {
        const dependencyId =
          plannedStep.skipReason === "unmet-dependency"
            ? plannedStep.dependencies.find((id) => plannedSteps.get(id)?.skipReason !== undefined)
            : undefined;
        const report = recordSkip(
          step,
          step.id,
          reports,
          reportsByStepId,
          plannedStep.skipReason,
          undefined,
          dependencyId,
          undefined,
          undefined,
          runtime.now()
        );
        publishStepReport(plannedStep, report);
        continue;
      }
      if (cancellationError) {
        const report: PipelineStepCancelledReport = {
          id: step.id,
          name: step.name,
          description: step.description,
          error: { ...cancellationError, stepId: step.id },
          finishedAtMs: runtime.now(),
          status: "cancelled",
        };
        reports.push(report);
        reportsByStepId.set(step.id, report);
        publishStepReport(plannedStep, report);
        continue;
      }
      const report = recordSkip(
        step,
        step.id,
        reports,
        reportsByStepId,
        "fail-fast",
        failedStepId
          ? `Not run because fail-fast stopped after ${failedStepId} failed.`
          : "Not run because the pipeline was aborted before this step started.",
        failedStepId,
        undefined,
        undefined,
        runtime.now()
      );
      publishStepReport(plannedStep, report);
    }
  };

  const recordStepExecutionFailure = (
    error: unknown,
    plannedStep: PipelinePlanStep,
    step: AnyStep<TOptions>,
    stepId: string,
    stepIndex: number,
    attempt: { attemptId: string; startedAtMs: number }
  ): boolean => {
    const cancelled = isPipelineCancellation(error, runtime);
    const childFailure =
      error instanceof PipelineExecutionError || error instanceof PipelineChildError;
    const validationFailure = error instanceof PipelineBoundaryValidationError;
    const pipelineError = toPipelineError(error, {
      code: cancelled
        ? "TUBELESS_RUN_CANCELLED"
        : validationFailure
          ? "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED"
          : childFailure
            ? "TUBELESS_CHILD_FAILED"
            : "TUBELESS_STEP_FAILED",
      kind: cancelled
        ? "cancellation"
        : validationFailure
          ? "validation"
          : childFailure
            ? "child"
            : "step",
      phase: "execution",
      stepId,
    });
    errors.push(pipelineError);
    const finishedAtMs = runtime.now();
    const report: PipelineStepCancelledReport | PipelineStepFailedReport = cancelled
      ? {
          attemptId: attempt.attemptId,
          id: stepId,
          name: step.name,
          description: step.description,
          error: pipelineError,
          finishedAtMs,
          startedAtMs: attempt.startedAtMs,
          status: "cancelled",
        }
      : {
          attemptId: attempt.attemptId,
          id: stepId,
          name: step.name,
          description: step.description,
          error: pipelineError,
          finishedAtMs,
          startedAtMs: attempt.startedAtMs,
          status: "failed",
        };
    reports.push(report);
    reportsByStepId.set(stepId, report);
    publishStepReport(plannedStep, report);
    completed = false;
    if (!controls.continueOnError) {
      recordRemainingStates(
        stepIndex + 1,
        stepId,
        report.status === "cancelled" ? pipelineError : undefined
      );
      return true;
    }
    return false;
  };

  const recordPublishedStepValue = async (args: {
    attempt?: { attemptId: string; startedAtMs: number };
    kind: "complete" | "policy-skip";
    plannedStep: PipelinePlanStep;
    skipMessage?: string;
    step: AnyStep<TOptions>;
    stepId: string;
    stepIndex: number;
    value: unknown;
  }): Promise<boolean> => {
    let published = args.value;
    let attempt = args.attempt;
    if (args.step.outputSchema) {
      if (!attempt) {
        attempt = beginAttempt(args.stepId, runtime.now());
        publishStepStatus({
          attemptId: attempt.attemptId,
          pipelineId: compiled.id,
          status: "running",
          step: args.plannedStep,
        });
      }
      try {
        published = await validateStandardSchema(
          args.step.outputSchema,
          published,
          `Pipeline ${compiled.id} step ${args.stepId} output`
        );
      } catch (error) {
        return recordStepExecutionFailure(
          error,
          args.plannedStep,
          args.step,
          args.stepId,
          args.stepIndex,
          attempt
        );
      }
    }
    outputs.set(args.stepId, published);
    if (args.kind === "complete") {
      const completeAttempt = attempt!;
      const report: PipelineStepCompleteReport = {
        attemptId: completeAttempt.attemptId,
        id: args.stepId,
        name: args.step.name,
        description: args.step.description,
        finishedAtMs: runtime.now(),
        startedAtMs: completeAttempt.startedAtMs,
        status: "completed",
      };
      reports.push(report);
      reportsByStepId.set(args.stepId, report);
      publishStepReport(args.plannedStep, report);
      return false;
    }
    const report = recordSkip(
      args.step,
      args.stepId,
      reports,
      reportsByStepId,
      "policy",
      args.skipMessage,
      undefined,
      attempt?.attemptId,
      attempt?.startedAtMs,
      runtime.now()
    );
    publishStepReport(args.plannedStep, report);
    return false;
  };

  for (const [stepIndex, step] of orderedSteps.entries()) {
    const stepId = step.id;
    const plannedStep = plannedSteps.get(stepId) ?? stepToPlanStep(step, true);

    try {
      throwIfAborted(runtime);
    } catch (error) {
      const pipelineError = toPipelineError(error, {
        code: "TUBELESS_RUN_CANCELLED",
        kind: "cancellation",
        phase: "execution",
        stepId,
      });
      errors.push(pipelineError);
      completed = false;
      recordRemainingStates(stepIndex, undefined, pipelineError);
      break;
    }

    const disposition = decideStepDisposition({
      dryRun,
      planned: plannedStep,
      reportsByStepId,
      step,
    });
    if (disposition.kind === "skip") {
      const report = recordSkip(
        step,
        stepId,
        reports,
        reportsByStepId,
        disposition.reason,
        disposition.message,
        disposition.dependencyId,
        undefined,
        undefined,
        runtime.now()
      );
      publishStepReport(plannedStep, report);
      continue;
    }

    const inputs: Record<string, unknown> = {};
    for (const dep of step.dependsOn ?? []) {
      inputs[dep.id] = outputs.get(dep.id);
    }
    for (const dep of step.optionalDependsOn ?? []) {
      if (outputs.has(dep.id)) {
        inputs[dep.id] = outputs.get(dep.id);
      }
    }

    if (typeof step.skip === "function") {
      let skipDecision: ReturnType<typeof normalizeStepSkipDecision>;
      try {
        skipDecision = normalizeStepSkipDecision(
          await step.skip(inputs, { ...executionContext, log: tracedLogger(stepId) })
        );
      } catch (error) {
        const skipAttempt = beginAttempt(stepId, runtime.now());
        publishStepStatus({
          attemptId: skipAttempt.attemptId,
          pipelineId: compiled.id,
          status: "running",
          step: plannedStep,
        });
        if (recordStepExecutionFailure(error, plannedStep, step, stepId, stepIndex, skipAttempt)) {
          break;
        }
        continue;
      }
      if (skipDecision) {
        if (
          await recordPublishedStepValue({
            kind: "policy-skip",
            plannedStep,
            skipMessage: skipDecision.reason,
            step,
            stepId,
            stepIndex,
            value: skipDecision.value,
          })
        ) {
          break;
        }
        continue;
      }
    }

    const stepStartedAt = runtime.now();
    const attempt = beginAttempt(stepId, stepStartedAt);
    publishStepStatus({
      attemptId: attempt.attemptId,
      pipelineId: compiled.id,
      status: "running",
      step: plannedStep,
    });
    try {
      let acceptsProgress = true;
      const publishProgress = (progress: PipelineStepProgress): void => {
        if (!acceptsProgress) return;
        publishStepStatus({
          attemptId: attempt.attemptId,
          pipelineId: compiled.id,
          progress,
          status: "running",
          step: plannedStep,
        });
      };
      const stepContext: PipelineStepContext<TOptions> = {
        ...executionContext,
        attemptId: attempt.attemptId,
        log: tracedLogger(stepId, attempt.attemptId),
        reportAttempt: (attempt, attributes) => {
          lifecycle.reportAttempt(stepId, attempt, attributes, stepContext.attemptId);
        },
        reportProgress: (progress) => {
          publishProgress(progress);
        },
      };
      let output: unknown;
      try {
        output =
          dryRun && typeof step.dryRun === "function"
            ? await step.dryRun(inputs, stepContext)
            : await step.run(inputs, stepContext);
      } finally {
        acceptsProgress = false;
      }
      if (
        await recordPublishedStepValue({
          attempt,
          kind: "complete",
          plannedStep,
          step,
          stepId,
          stepIndex,
          value: output,
        })
      ) {
        break;
      }
    } catch (error) {
      if (recordStepExecutionFailure(error, plannedStep, step, stepId, stepIndex, attempt)) {
        break;
      }
    }
  }

  let value: TPipelineResult | undefined;
  let finalized = false;
  if (completed || controls.continueOnError) {
    const finalizeStartedAt = runtime.now();
    lifecycle.finalizeStart();
    try {
      throwIfAborted(runtime);
      // SAFETY: `outputs` maps step ids to their produced values, which is
      // exactly the shape the finalizer's outputs parameter describes.
      const finalOutputs = Object.fromEntries(outputs) as Parameters<
        CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>["finalize"]
      >[0];
      const finalizedValue = await compiled.finalize(finalOutputs, {
        ...executionContext,
        log: tracedLogger(PIPELINE_FINALIZE_STEP_ID),
      });
      // SAFETY: with a result schema the value is validated against
      // `TPipelineResult`; without one the finalizer's declared return type
      // is `TPipelineResult`, so the cast only restores that type.
      value = compiled.resultSchema
        ? ((await validateStandardSchema(
            compiled.resultSchema,
            finalizedValue,
            `Pipeline ${compiled.id} final result`
          )) as TPipelineResult)
        : (finalizedValue as TPipelineResult);
      finalized = true;
      lifecycle.finalizeComplete(runtime.now() - finalizeStartedAt, value);
    } catch (error) {
      const cancelled = isPipelineCancellation(error, runtime);
      const validationFailure = error instanceof PipelineBoundaryValidationError;
      const pipelineError = toPipelineError(error, {
        code: cancelled
          ? "TUBELESS_FINALIZATION_CANCELLED"
          : validationFailure
            ? "TUBELESS_FINAL_RESULT_VALIDATION_FAILED"
            : "TUBELESS_FINALIZATION_FAILED",
        kind: cancelled ? "cancellation" : validationFailure ? "validation" : "finalization",
        phase: "finalization",
        stepId: PIPELINE_FINALIZE_STEP_ID,
      });
      errors.push(pipelineError);
      lifecycle.finalizeError(pipelineError, runtime.now() - finalizeStartedAt);
      completed = false;
    }
  }

  const finishedAtMs = runtime.now();
  const result: PipelineRun<TPipelineResult> = {
    pipelineId: compiled.id,
    dryRun,
    errors,
    finalized,
    finishedAtMs,
    runId,
    startedAtMs: startedAt,
    status: terminalRunStatus(errors),
    steps: reports,
    value,
    version: RUN_MODEL_VERSION,
  };
  if (parentRunId) result.parentRunId = parentRunId;
  lifecycle.pipelineComplete(result);
  await lifecycle.flush();
  return result;
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
