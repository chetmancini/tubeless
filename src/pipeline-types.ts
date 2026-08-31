import type { RUN_MODEL_VERSION } from "./pipeline-ids.js";
import type {
  PipelineTraceAttributes,
  PipelineTraceContext,
  PipelineTracingOptions,
} from "./tracing.js";

export interface PipelineLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void;
  log(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface PipelineContext {
  cwd: string;
  /** Hook sets run in order and failures are isolated per set. */
  hooks?: PipelineHooks | readonly PipelineHooks[];
  log: PipelineLogger;
  /** Timestamp source for persisted run records. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional caller-owned parent run identity for nested or resumed orchestration. */
  parentRunId?: string;
  /** Optional caller-owned run identity. A unique ID is generated when omitted. */
  runId?: string;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  /** Optional structured lifecycle tracing configuration for this run. */
  tracing?: PipelineTracingOptions;
}

export interface PipelineRunControls<
  TStepId extends string = string,
  TTargetId extends string = string,
> {
  continueOnError?: boolean;
  dryRun?: boolean;
  /**
   * Run only these steps; omitted or undefined runs every step. An empty array
   * is invalid and fails planning/execution instead of silently running nothing.
   */
  stepIds?: readonly TStepId[];
  /**
   * Run these declared pipeline targets and the upstream work required to
   * reach them. Required inputs and failure gates are included recursively;
   * optional-only inputs are not. Cannot be combined with exact `stepIds`
   * filtering.
   */
  targets?: readonly TTargetId[];
}

/** Domain input plus built-in controls. Child `mapOptions` still returns this mix. */
export type PipelineRunOptions<
  TOptions extends object = object,
  TStepId extends string = string,
  TTargetId extends string = string,
> = TOptions & PipelineRunControls<TStepId, TTargetId>;
export interface PipelineRuntime extends PipelineContext {
  now: () => number;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface PipelineExecutionContext<TOptions extends object> extends PipelineRuntime {
  dryRun: boolean;
  options: TOptions;
  /** Stable identity for this execution, whether or not tracing is configured. */
  runId: string;
  /** Parent execution identity when this run was started by another run. */
  parentRunId?: string;
  /** Stable identities for this traced run; absent unless `context.tracing` is configured. */
  trace?: PipelineTraceContext;
}

/**
 * Optional indented detail row under a parent step's progress.
 * Domain-agnostic: mapped children, nested work units, per-file status, etc.
 */
export type PipelineStepProgressDetailStatus =
  | "completed"
  | "failed"
  | "pending"
  | "running"
  | "skipped";

export interface PipelineStepProgressDetail {
  /** Stable identity for the row (item key, path, job id, …). */
  id: string;
  /** Short status text shown after the id. */
  label?: string;
  /** Controls the detail row symbol. Defaults to `running`. */
  status?: PipelineStepProgressDetailStatus;
}

export interface PipelineStepProgress {
  /** Work completed so far. Values outside the reported total are allowed but renderers may clamp them. */
  completed: number;
  /** Total work when known. Omit for indeterminate progress. */
  total?: number;
  /** Optional short status shown next to the step. Prefer one-line summaries. */
  message?: string;
  /**
   * Optional multi-line detail rows for capable reporters (interactive TTY).
   * Keep the parent `message` as a summary; put per-item status here so high
   * concurrency does not collapse onto one truncated line.
   */
  details?: readonly PipelineStepProgressDetail[];
}

export interface PipelineStepContext<
  TOptions extends object,
> extends PipelineExecutionContext<TOptions> {
  /** Stable identity for this execution of the current step. */
  attemptId: string;
  /** Emit a retry/attempt trace event for this step when tracing is enabled. */
  reportAttempt(attempt: number, attributes?: PipelineTraceAttributes): void;
  /** Publish the latest progress snapshot for this step. */
  reportProgress(progress: PipelineStepProgress): void;
}

export interface RemoteStepAdapter<TOptions extends object, TPayload, TResult> {
  /** Presentation only. The kernel never switches on this. */
  readonly engine: string;
  /** Function name, workflow type, URL, queue. Presentation only. */
  readonly target?: string;
  invoke(payload: TPayload, context: PipelineStepContext<TOptions>): Promise<TResult>;
}

export type PipelineErrorPhase = "definition" | "execution" | "finalization" | "planning";

export type PipelineErrorKind =
  | "cancellation"
  | "child"
  | "definition"
  | "finalization"
  | "selection"
  | "step"
  | "validation";

/** Stable package-owned codes for pipeline errors. */
export type PipelineErrorCode =
  | "TUBELESS_CHILD_FAILED"
  | "TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY"
  | "TUBELESS_DEFINITION_DEPENDENCY_CYCLE"
  | "TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE"
  | "TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS"
  | "TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE"
  | "TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS"
  | "TUBELESS_DEFINITION_PIPELINE_ID_BLANK"
  | "TUBELESS_DEFINITION_OPTIONS_SCHEMA_CONFLICT"
  | "TUBELESS_DEFINITION_STEP_ID_BLANK"
  | "TUBELESS_DEFINITION_STEP_ID_RESERVED"
  | "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE"
  | "TUBELESS_DEFINITION_STEP_NAME_BLANK"
  | "TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH"
  | "TUBELESS_DEFINITION_TARGET_NOT_IN_STEPS"
  | "TUBELESS_DEFINITION_TARGETS_DUPLICATE"
  | "TUBELESS_FINALIZATION_CANCELLED"
  | "TUBELESS_FINALIZATION_FAILED"
  | "TUBELESS_FINAL_RESULT_VALIDATION_FAILED"
  | "TUBELESS_OPTIONS_VALIDATION_FAILED"
  | "TUBELESS_PLANNING_SELECTION_CONFLICT"
  | "TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE"
  | "TUBELESS_PLANNING_STEP_SELECTION_EMPTY"
  | "TUBELESS_PLANNING_STEP_UNKNOWN"
  | "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE"
  | "TUBELESS_PLANNING_TARGET_SELECTION_EMPTY"
  | "TUBELESS_PLANNING_TARGET_UNDECLARED"
  | "TUBELESS_PLANNING_TARGET_UNKNOWN"
  | "TUBELESS_RUN_CANCELLED"
  | "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED"
  | "TUBELESS_STEP_FAILED";

/** One dependency-free Standard Schema issue normalized for reports and traces. */
export interface PipelineValidationIssue {
  message: string;
  path?: readonly (number | string)[];
}

export interface PipelineError {
  /** Bounded, JSON-safe snapshot of the thrown error's cause chain. */
  cause?: PipelineErrorCause;
  code: PipelineErrorCode;
  kind: PipelineErrorKind;
  message: string;
  phase: PipelineErrorPhase;
  /** Present when a Standard Schema rejected a boundary value. */
  issues?: readonly PipelineValidationIssue[];
  stepId?: string;
  /** Machine-readable code copied from the original thrown error, when present. */
  sourceCode?: string;
  stack?: string;
}

/** Dependency-free subset of the Standard Schema V1 protocol. */
export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": StandardSchemaV1Props<TInput, TOutput>;
}

export interface StandardSchemaV1Props<TInput = unknown, TOutput = TInput> {
  readonly types?: { readonly input: TInput; readonly output: TOutput };
  readonly validate: (
    value: unknown,
    options?: { readonly libraryOptions?: Record<string, unknown> }
  ) => StandardSchemaV1Result<TOutput> | Promise<StandardSchemaV1Result<TOutput>>;
  readonly vendor: string;
  readonly version: 1;
}

export type StandardSchemaV1Result<TOutput> =
  | { readonly issues?: undefined; readonly value: TOutput }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

/** Infer the accepted input type from a Standard Schema without importing its package. */
export type InferSchemaInput<TSchema extends StandardSchemaV1> = NonNullable<
  TSchema["~standard"]["types"]
>["input"];

/** Infer the validated output type from a Standard Schema without importing its package. */
export type InferSchemaOutput<TSchema extends StandardSchemaV1> = NonNullable<
  TSchema["~standard"]["types"]
>["output"];

export interface PipelineErrorCause {
  cause?: PipelineErrorCause;
  message: string;
  name?: string;
  /** Machine-readable code copied from this cause, when present. */
  sourceCode?: string;
}

interface PipelineStepReportBase {
  /** Present when the step started an execution attempt. */
  attemptId?: string;
  id: string;
  /** Optional human-facing display name. Stable machine identity remains `id`. */
  name?: string;
  description?: string;
  /** Wall-clock time when this terminal report was recorded. */
  finishedAtMs: number;
  /** Wall-clock time when execution began; absent when the step never started. */
  startedAtMs?: number;
}

export interface PipelineStepCompleteReport extends PipelineStepReportBase {
  attemptId: string;
  startedAtMs: number;
  status: "completed";
}

export interface PipelineStepSkippedReport extends PipelineStepReportBase {
  /** Dependency that blocked this step, when applicable. */
  dependencyId?: string;
  /** Human-readable skip detail, especially for policy and fail-fast skips. */
  message?: string;
  reason: PipelineStepSkipReason;
  status: "skipped";
}

export interface PipelineStepCancelledReport extends PipelineStepReportBase {
  error: PipelineError;
  status: "cancelled";
}

export interface PipelineStepFailedReport extends PipelineStepReportBase {
  attemptId: string;
  error: PipelineError;
  startedAtMs: number;
  status: "failed";
}

/** Terminal state recorded for one step after a run. */
export type PipelineStepReport =
  | PipelineStepCancelledReport
  | PipelineStepFailedReport
  | PipelineStepSkippedReport
  | PipelineStepCompleteReport;

export type PipelineStepReportStatus = PipelineStepReport["status"];

/** Terminal disposition of a completed run record. */
export type PipelineRunStatus = "cancelled" | "completed" | "failed";

/** Versioned public record returned for one pipeline execution. */
export interface PipelineRun<TResult = unknown> {
  pipelineId: string;
  dryRun: boolean;
  errors: PipelineError[];
  finalized: boolean;
  finishedAtMs: number;
  parentRunId?: string;
  runId: string;
  startedAtMs: number;
  status: PipelineRunStatus;
  steps: PipelineStepReport[];
  value?: TResult;
  version: typeof RUN_MODEL_VERSION;
}

/**
 * Why a step did not run. Built-in structural reasons keep dependency semantics;
 * `"policy"` is an intentional skip from `step.skip()` (still unlocks dependents).
 */
export type PipelineStepSkipReason =
  | "dry-run"
  | "failed-dependency"
  | "fail-fast"
  | "filtered"
  | "policy"
  | "unmet-dependency";

/**
 * Decision from an optional `skip` predicate.
 * - falsy / `false` → run the step
 * - non-empty string → skip with that message (`reason: "policy"`); the step's
 *   published output is `undefined`
 * - `{ reason, value? }` → skip and optionally publish `value` for dependents
 *   (`value` may be intentionally `undefined` if passed explicitly)
 *
 * Policy skips unlock required dependents. Because a bare-string skip (or a
 * `{ reason }` without `value`) publishes `undefined`, any step that declares
 * `skip` is typed so dependents see `TOut | undefined`. Prefer returning
 * `{ reason, value }` on every skip path when dependents need a real output.
 */
export type StepSkipDecision<TOut = unknown> =
  | false
  | null
  | undefined
  | string
  | { reason: string; value?: TOut };

/** One observable status in a step's planned → running → terminal lifecycle. */
export type PipelineStepStatus =
  | { pipelineId: string; status: "planned"; step: PipelinePlanStep }
  | {
      attemptId: string;
      pipelineId: string;
      progress?: PipelineStepProgress;
      status: "running";
      step: PipelinePlanStep;
    }
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepCancelledReport)
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepFailedReport)
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepSkippedReport)
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepCompleteReport);

export type PipelineStepLifecycleStatus = PipelineStepStatus["status"];

export type PipelineStepPlannedEvent = Extract<PipelineStepStatus, { status: "planned" }>;
type PipelineStepRunningStatus = Extract<PipelineStepStatus, { status: "running" }>;
export type PipelineStepStartEvent = Omit<PipelineStepRunningStatus, "progress"> & {
  progress?: undefined;
};
export type PipelineStepProgressEvent = Omit<PipelineStepRunningStatus, "progress"> & {
  progress: PipelineStepProgress;
};
export type PipelineStepCancelledEvent = Extract<PipelineStepStatus, { status: "cancelled" }>;
export type PipelineStepFailedEvent = Extract<PipelineStepStatus, { status: "failed" }>;
export type PipelineStepSkippedEvent = Extract<PipelineStepStatus, { status: "skipped" }>;
export type PipelineStepCompleteEvent = Extract<PipelineStepStatus, { status: "completed" }>;

export interface PipelineHooks<TResult = unknown> {
  onFinalizeComplete?(event: { durationMs: number; pipelineId: string; value: TResult }): void;
  onFinalizeError?(event: { durationMs: number; error: PipelineError; pipelineId: string }): void;
  onFinalizeStart?(event: { pipelineId: string }): void;
  onPipelineComplete?(event: PipelineRun<TResult>): void;
  onPipelineStart?(event: PipelinePlan): void;
  onStepCancel?(event: PipelineStepCancelledEvent): void;
  onStepFail?(event: PipelineStepFailedEvent): void;
  onStepPlan?(event: PipelineStepPlannedEvent): void;
  onStepProgress?(event: PipelineStepProgressEvent): void;
  onStepSkip?(event: PipelineStepSkippedEvent): void;
  onStepStart?(event: PipelineStepStartEvent): void;
  onStepStatus?(event: PipelineStepStatus): void;
  onStepComplete?(event: PipelineStepCompleteEvent): void;
}

/** Machine-readable explanation of why a planned step was included or omitted. */
export type PipelineStepSelectionReason =
  | { kind: "all" }
  | { kind: "exact" }
  | { kind: "target"; targetId: string }
  | { dependentId: string; kind: "required-dependency"; targetId: string }
  | { dependentId: string; kind: "failure-gate"; targetId: string }
  | { dependentId: string; kind: "optional-only"; targetId: string }
  | { kind: "outside-target-closure" }
  | { kind: "not-selected" };

export interface PipelinePlanStep {
  dependencies: string[];
  description?: string;
  /** How this step behaves when the pipeline is run with `dryRun: true`. */
  dryRun: "custom" | "run" | "skip";
  id: string;
  /** Optional human-facing display name. Stable machine identity remains `id`. */
  name?: string;
  /** Static child structure when this opaque step executes another pipeline. */
  nestedPipeline?: {
    /** One child execution or one child execution per runtime item. */
    mode: "single" | "for-each";
    pipelineId: string;
    /** All declared child step ids; runtime selection may execute only a subset. */
    stepIds: readonly string[];
  };
  /** Static remote adapter metadata when this opaque step calls an external engine. */
  remote?: {
    engine: string;
    target?: string;
  };
  optionalDependencies: string[];
  /** True when the step's runtime policy may elect not to run it. */
  runtimeSkipPossible: boolean;
  selected: boolean;
  /** Stable reasons for selection or omission; shared prerequisites can have several. */
  selectionReasons: readonly PipelineStepSelectionReason[];
  skipAfterFailureOf: string[];
  skipReason?: PipelineStepSkipReason;
}

export interface PipelinePlan {
  dryRun: boolean;
  errors: PipelineError[];
  ok: boolean;
  pipelineId: string;
  steps: PipelinePlanStep[];
}

/** Layout direction for generated Mermaid flowcharts. */
export type PipelineMermaidDirection = "BT" | "LR" | "RL" | "TB" | "TD";

export interface PipelineMermaidOptions {
  /** Mermaid flowchart direction. Defaults to top-down (`TD`). */
  direction?: PipelineMermaidDirection;
  /** Append each operational description to its node label. Defaults to false. */
  includeDescriptions?: boolean;
}

export interface Pipeline<
  TOptions extends object,
  TResult,
  TStepId extends string = string,
  TTargetId extends string = TStepId,
> {
  readonly id: string;
  /** Stable definition-order step ids for discovery surfaces such as CLI help. */
  readonly stepIds: readonly TStepId[];
  /** Stable declared goal ids that support dependency-aware target execution. */
  readonly targetIds: readonly TTargetId[];
  plan(controls?: PipelineRunControls<TStepId, TTargetId>): PipelinePlan;
  run(
    options: TOptions,
    controls?: PipelineRunControls<TStepId, TTargetId>,
    context?: Partial<PipelineContext>
  ): Promise<PipelineRun<TResult>>;
  runOrThrow(
    options: TOptions,
    controls?: PipelineRunControls<TStepId, TTargetId>,
    context?: Partial<PipelineContext>
  ): Promise<TResult>;
  /** Generate a static Mermaid flowchart without running or planning the pipeline. */
  toMermaid(options?: PipelineMermaidOptions): string;
}
