import type { PipelineLifecycleObserver } from "./lifecycle.js";
import { RUN_MODEL_VERSION } from "./pipeline-ids.js";
import type {
  PipelineError,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineRunStatus,
  PipelineStepCancelledReport,
  PipelineStepCompleteReport,
  PipelineStepFailedReport,
  PipelineStepProgress,
  PipelineStepReport,
  PipelineStepSkipReason,
  PipelineStepSkippedReport,
  PipelineStepStatus,
} from "./pipeline-types.js";

export interface PipelineStepAttempt {
  attemptId: string;
  startedAtMs: number;
}

type RunPhase = "created" | "finalizing" | "finished" | "running";

type StepTransitionEffects = {
  error?: { record: boolean; value: PipelineError };
  output?: { value: unknown };
};

export function isCancellationOnly(errors: readonly PipelineError[]): boolean {
  return errors.length > 0 && errors.every(({ kind }) => kind === "cancellation");
}

function terminalRunStatus(errors: readonly PipelineError[]): PipelineRunStatus {
  if (errors.length === 0) return "completed";
  return isCancellationOnly(errors) ? "cancelled" : "failed";
}

function stepReportFromStatus(
  event: Exclude<PipelineStepStatus, { status: "planned" | "running" }>
): PipelineStepReport {
  const base = {
    id: event.id,
    name: event.name,
    description: event.description,
    finishedAtMs: event.finishedAtMs,
  };
  switch (event.status) {
    case "completed":
      return {
        ...base,
        attemptId: event.attemptId,
        startedAtMs: event.startedAtMs,
        status: "completed",
      };
    case "failed":
      return {
        ...base,
        attemptId: event.attemptId,
        error: event.error,
        startedAtMs: event.startedAtMs,
        status: "failed",
      };
    case "cancelled": {
      const report: PipelineStepCancelledReport = {
        ...base,
        error: event.error,
        status: "cancelled",
      };
      if (event.attemptId) report.attemptId = event.attemptId;
      if (event.startedAtMs !== undefined) report.startedAtMs = event.startedAtMs;
      return report;
    }
    case "skipped": {
      const report: PipelineStepSkippedReport = {
        ...base,
        reason: event.reason,
        status: "skipped",
      };
      if (event.attemptId) report.attemptId = event.attemptId;
      if (event.startedAtMs !== undefined) report.startedAtMs = event.startedAtMs;
      if (event.dependencyId) report.dependencyId = event.dependencyId;
      if (event.message) report.message = event.message;
      return report;
    }
  }
}

export class PipelineRunState<TResult> {
  readonly #currentStepStatuses = new Map<string, PipelineStepStatus["status"]>();
  readonly #errors: PipelineError[] = [];
  readonly #outputs = new Map<string, unknown>();
  readonly #stepOrder = new Map<string, number>();
  readonly #reportsByStepId = new Map<string, PipelineStepReport>();
  #definitionIdentity: PipelineRun["definitionIdentity"];
  #finalizationAttempted = false;
  #finalized = false;
  #nextAttemptSequence = 0;
  #phase: RunPhase = "created";
  #value: TResult | undefined;

  constructor(
    readonly pipelineId: string,
    readonly dryRun: boolean,
    readonly startedAtMs: number,
    readonly identity: { correlationId?: string; parentRunId?: string; runId: string },
    readonly now: () => number,
    readonly lifecycle: PipelineLifecycleObserver
  ) {}

  get errors(): readonly PipelineError[] {
    return this.#errors;
  }

  get outputs(): ReadonlyMap<string, unknown> {
    return this.#outputs;
  }

  get reportsByStepId(): ReadonlyMap<string, PipelineStepReport> {
    return this.#reportsByStepId;
  }

  start(plan: PipelinePlan, targetIds: readonly string[]): void {
    this.#expectPhase("created");
    this.#phase = "running";
    this.#definitionIdentity = plan.definition?.identity;
    plan.steps.forEach((step, index) => this.#stepOrder.set(step.id, index));
    this.lifecycle.pipelineStart(plan, targetIds);
  }

  planStep(step: PipelinePlanStep): void {
    this.#applyStepStatus({ pipelineId: this.pipelineId, status: "planned", step });
  }

  beginAttempt(step: PipelinePlanStep, startedAtMs = this.now()): PipelineStepAttempt {
    const attempt = {
      attemptId: `${this.identity.runId}:attempt:${(this.#nextAttemptSequence += 1).toString(36)}`,
      startedAtMs,
    };
    this.#applyStepStatus({
      attemptId: attempt.attemptId,
      pipelineId: this.pipelineId,
      status: "running",
      step,
    });
    return attempt;
  }

  reportProgress(
    step: PipelinePlanStep,
    attempt: PipelineStepAttempt,
    progress: PipelineStepProgress
  ): void {
    this.#applyStepStatus({
      attemptId: attempt.attemptId,
      pipelineId: this.pipelineId,
      progress,
      status: "running",
      step,
    });
  }

  completeStep(step: PipelinePlanStep, attempt: PipelineStepAttempt, value: unknown): void {
    const report: PipelineStepCompleteReport = {
      attemptId: attempt.attemptId,
      id: step.id,
      name: step.name,
      description: step.description,
      finishedAtMs: this.now(),
      startedAtMs: attempt.startedAtMs,
      status: "completed",
    };
    this.#applyStepStatus({ ...report, pipelineId: this.pipelineId, step }, { output: { value } });
  }

  skipStep(
    step: PipelinePlanStep,
    input: {
      attempt?: PipelineStepAttempt;
      dependencyId?: string;
      message?: string;
      output?: { value: unknown };
      reason: PipelineStepSkipReason;
    }
  ): void {
    const report: PipelineStepSkippedReport = {
      id: step.id,
      name: step.name,
      description: step.description,
      finishedAtMs: this.now(),
      reason: input.reason,
      status: "skipped",
    };
    if (input.attempt) {
      report.attemptId = input.attempt.attemptId;
      report.startedAtMs = input.attempt.startedAtMs;
    }
    if (input.dependencyId) report.dependencyId = input.dependencyId;
    if (input.message) report.message = input.message;
    this.#applyStepStatus(
      { ...report, pipelineId: this.pipelineId, step },
      input.output ? { output: input.output } : undefined
    );
  }

  failStep(step: PipelinePlanStep, attempt: PipelineStepAttempt, error: PipelineError): void {
    if (error.kind === "cancellation") {
      this.cancelStep(step, error, true, attempt);
      return;
    }
    const report: PipelineStepFailedReport = {
      attemptId: attempt.attemptId,
      id: step.id,
      name: step.name,
      description: step.description,
      error,
      finishedAtMs: this.now(),
      startedAtMs: attempt.startedAtMs,
      status: "failed",
    };
    this.#applyStepStatus(
      { ...report, pipelineId: this.pipelineId, step },
      { error: { record: true, value: error } }
    );
  }

  cancelStep(
    step: PipelinePlanStep,
    error: PipelineError,
    recordError: boolean,
    attempt?: PipelineStepAttempt
  ): void {
    const report: PipelineStepCancelledReport = {
      id: step.id,
      name: step.name,
      description: step.description,
      error,
      finishedAtMs: this.now(),
      status: "cancelled",
    };
    if (attempt) {
      report.attemptId = attempt.attemptId;
      report.startedAtMs = attempt.startedAtMs;
    }
    this.#applyStepStatus(
      { ...report, pipelineId: this.pipelineId, step },
      { error: { record: recordError, value: error } }
    );
  }

  recordRunErrors(errors: readonly PipelineError[]): void {
    this.#expectPhase("running");
    this.#errors.push(...errors);
  }

  beginFinalization(): void {
    this.#expectPhase("running");
    this.#expectAllStepsTerminal();
    if (this.#finalizationAttempted) throw new Error("Pipeline finalization already attempted");
    this.#finalizationAttempted = true;
    this.#phase = "finalizing";
    this.lifecycle.finalizeStart();
  }

  completeFinalization(value: TResult, durationMs: number): void {
    this.#expectPhase("finalizing");
    this.#value = value;
    this.#finalized = true;
    this.#phase = "running";
    this.lifecycle.finalizeComplete(durationMs, value);
  }

  failFinalization(error: PipelineError, durationMs: number): void {
    this.#expectPhase("finalizing");
    this.#errors.push(error);
    this.#phase = "running";
    this.lifecycle.finalizeError(error, durationMs);
  }

  async finish(): Promise<PipelineRun<TResult>> {
    this.#expectPhase("running");
    this.#expectAllStepsTerminal();
    this.#phase = "finished";
    const errorOrder = (error: PipelineError): number => {
      if (error.phase === "finalization") return this.#stepOrder.size;
      return error.stepId === undefined ? -1 : (this.#stepOrder.get(error.stepId) ?? -1);
    };
    // Live observations retain event order; only the finished record is ordered by plan.
    const errors = [...this.#errors].sort((left, right) => errorOrder(left) - errorOrder(right));
    const steps = [...this.#reportsByStepId.values()].sort(
      (left, right) => this.#stepOrder.get(left.id)! - this.#stepOrder.get(right.id)!
    );
    const result: PipelineRun<TResult> = {
      pipelineId: this.pipelineId,
      dryRun: this.dryRun,
      errors,
      finalized: this.#finalized,
      finishedAtMs: this.now(),
      runId: this.identity.runId,
      startedAtMs: this.startedAtMs,
      status: terminalRunStatus(this.#errors),
      steps,
      value: this.#value,
      version: RUN_MODEL_VERSION,
    };
    if (this.#definitionIdentity) result.definitionIdentity = this.#definitionIdentity;
    if (this.identity.correlationId !== undefined) {
      result.correlationId = this.identity.correlationId;
    }
    if (this.identity.parentRunId) result.parentRunId = this.identity.parentRunId;
    this.lifecycle.pipelineComplete(result);
    await this.lifecycle.flush();
    return result;
  }

  #applyStepStatus(event: PipelineStepStatus, effects: StepTransitionEffects = {}): void {
    this.#expectPhase("running");
    const previous = this.#currentStepStatuses.get(event.step.id);
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

    this.#currentStepStatuses.set(event.step.id, event.status);
    if (event.status !== "planned" && event.status !== "running") {
      const report = stepReportFromStatus(event);
      this.#reportsByStepId.set(event.step.id, report);
    }
    if (effects.output) this.#outputs.set(event.step.id, effects.output.value);
    if (effects.error?.record) this.#errors.push(effects.error.value);
    this.lifecycle.stepStatus(event);
  }

  #expectPhase(expected: RunPhase): void {
    if (this.#phase !== expected) {
      throw new Error(
        `Invalid pipeline run transition: expected ${expected}, found ${this.#phase}`
      );
    }
  }

  #expectAllStepsTerminal(): void {
    for (const [stepId, status] of this.#currentStepStatuses) {
      if (status === "planned" || status === "running") {
        throw new Error(`Cannot finish pipeline run while step ${stepId} is ${status}`);
      }
    }
  }
}
