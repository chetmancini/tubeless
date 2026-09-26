import type { ArtifactRecord } from "../tracing/artifact-metadata.js";
import type {
  PipelineDefinitionIdentityContract,
  PipelineDefinitionSnapshotContract,
} from "../tracing/tracing-schema.js";

/** Versioned graph identity, separate from the optional handler implementation version. */
export type PipelineDefinitionIdentity = Readonly<PipelineDefinitionIdentityContract>;
/** Serializable compiled semantics; no handlers, inputs, or application imports. */
type ReadonlyDefinition<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyDefinition<T[K]> }
  : T;
/** Immutable snapshot of the compiled pipeline definition recorded for inspection and tracing. */
export type PipelineDefinitionSnapshot = ReadonlyDefinition<PipelineDefinitionSnapshotContract>;

import type { RUN_MODEL_VERSION } from "./pipeline-ids.js";
import { PIPELINE_ERROR_CODES as PIPELINE_ERROR_CODE_VALUES } from "../tracing/tracing-schema.js";
import type {
  PipelineErrorKindContract,
  PipelineErrorPhaseContract,
} from "../tracing/tracing-schema.js";
import type {
  PipelineTraceAttributes,
  PipelineTraceContext,
  PipelineTracingOptions,
} from "../tracing/tracing-contracts.js";

/** Minimal logger used by pipeline execution, reporters, and CLI adapters. */
export interface PipelineLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void;
  log(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
}

/** Caller-supplied services and metadata shared by one pipeline execution. */
export interface PipelineContext {
  /** Optional caller-owned identifier used to correlate separate executions. */
  correlationId?: string;
  cwd: string;
  /** Hook sets run in order and failures are isolated per set. */
  hooks?: PipelineHooks | readonly PipelineHooks[];
  log: PipelineLogger;
  /** Timestamp source for persisted run records. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional package-generated execution identity of this run's parent. */
  parentRunId?: string;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  /** Optional structured lifecycle tracing configuration for this run. */
  tracing?: PipelineTracingOptions;
}

/** Built-in run controls. Choose targets or stepIds, or omit both to run every step. */
export type PipelineRunControls<
  TStepId extends string = string,
  TTargetId extends string = string,
> = {
  /** Maximum simultaneous steps, including skip predicates and output validation. Defaults to 1. */
  maxConcurrency?: number;
  /** Continue eligible branches after failure; otherwise stop dispatch and drain active steps. */
  continueOnError?: boolean;
  dryRun?: boolean;
} & (
  | {
      /**
       * Run only these steps, without adding prerequisites. Omit both stepIds and
       * targets to run every step. An empty array is invalid and fails planning.
       */
      stepIds?: readonly TStepId[];
      targets?: undefined;
    }
  | {
      stepIds?: undefined;
      /**
       * Run these declared targets and their required inputs and failure gates,
       * recursively; optional-only inputs are not included. Omit both targets
       * and stepIds to run every step; no target is selected automatically.
       */
      targets?: readonly TTargetId[];
    }
);

/** Resolved caller context. Core fills `now` and `sleep` before execution. */
export interface PipelineRuntime extends PipelineContext {
  now: () => number;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}

/** Resolved execution context provided to pipeline handlers. */
export interface PipelineExecutionContext<TOptions extends object> extends PipelineRuntime {
  dryRun: boolean;
  options: TOptions;
  /** Stable identity for this execution, whether or not tracing is configured. */
  runId: string;
  /** Stable identities for this traced run; absent unless `context.tracing` is configured. */
  trace?: PipelineTraceContext;
}

/**
 * Lifecycle status displayed for an optional nested progress row.
 *
 * Detail rows are indented under a parent step's progress.
 * Domain-agnostic: mapped children, nested work units, per-file status, etc.
 */
export type PipelineStepProgressDetailStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "pending"
  | "running"
  | "skipped";

/** One optional nested row in a step progress snapshot. */
export interface PipelineStepProgressDetail {
  /** Provenance of a supplied test output, independent of the row status. */
  outputSource?: "override";
  /** Stable identity for the row (item key, path, job id, …). */
  id: string;
  /** Optional display name; identity remains `id`. */
  name?: string;
  /** Indentation relative to direct child rows (0). Rows are in tree preorder. */
  depth?: number;
  /** Inner work counts, independent of the parent's lifecycle count. */
  completed?: number;
  total?: number;
  /** Short status text shown after the id. */
  label?: string;
  /** Controls the detail row symbol. Defaults to `running`. */
  status?: PipelineStepProgressDetailStatus;
}

/** Latest progress snapshot reported by a running step. */
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

/** Step execution context with attempt identity and progress reporting helpers. */
export interface PipelineStepContext<
  TOptions extends object,
> extends PipelineExecutionContext<TOptions> {
  /** Stable identity for this execution of the current step. */
  attemptId: string;
  /** Record completed I/O without changing the step output. Calls after the handler settles are ignored. */
  recordArtifact(record: ArtifactRecord): void;
  /** Emit a retry/attempt trace event for this step when tracing is enabled. */
  reportAttempt(attempt: number, attributes?: PipelineTraceAttributes): void;
  /** Publish the latest progress snapshot for this step. */
  reportProgress(progress: PipelineStepProgress): void;
}

/** Adapter that invokes one step on an external execution engine. */
export interface RemoteStepAdapter<TOptions extends object, TPayload, TResult> {
  /** Presentation only. The kernel never switches on this. */
  readonly engine: string;
  /** Function name, workflow type, URL, queue. Presentation only. */
  readonly target?: string;
  invoke(payload: TPayload, context: PipelineStepContext<TOptions>): Promise<TResult>;
}

/** Pipeline lifecycle phase in which an error occurred. */
export type PipelineErrorPhase = PipelineErrorPhaseContract;

/** Broad category of a structured pipeline error. */
export type PipelineErrorKind = PipelineErrorKindContract;

/** Ordered catalog of every stable package-owned pipeline error code. */
export const PIPELINE_ERROR_CODES = Object.freeze(PIPELINE_ERROR_CODE_VALUES);

/** Stable package-owned code for a pipeline error. */
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

const pipelineErrorCodeSet: ReadonlySet<string> = new Set(PIPELINE_ERROR_CODES);

/** Return whether an unknown value is a stable package-owned pipeline error code. */
export function isPipelineErrorCode(value: unknown): value is PipelineErrorCode {
  return typeof value === "string" && pipelineErrorCodeSet.has(value);
}

/** One dependency-free Standard Schema issue normalized for reports and traces. */
export interface PipelineValidationIssue {
  message: string;
  path?: readonly (number | string)[];
}

/** Bounded diagnostics for a failed or cancelled runtime fan-out. */
export interface PipelineFanOutFailure {
  /** Original input position, including when the key is truncated. */
  index: number;
  /** At most 1024 UTF-16 code units; do not rerun by key when keyTruncated is true. */
  key: string;
  keyTruncated: boolean;
  cancelled: boolean;
  error: PipelineErrorCause;
}

/** Bounded diagnostics collected from a failed or cancelled fan-out step. */
export interface PipelineFanOutDiagnostics {
  /** Failed started items, in input order; at most 32 entries. */
  failures: readonly PipelineFanOutFailure[];
  /** Total failed started items, including omitted diagnostics. */
  failureCount: number;
  omittedFailureCount: number;
  /** Scheduler failure is separate and never assigned an item key. */
  schedulerError?: PipelineErrorCause;
}

/** Structured, machine-readable error stored in plans, runs, and traces. */
export interface PipelineError {
  /** Present for aggregated fan-out failures; absent for setup errors. */
  fanOut?: PipelineFanOutDiagnostics;
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

/** Standard Schema V1 metadata and validation contract consumed by Tubeless. */
interface StandardSchemaV1Props<TInput = unknown, TOutput = TInput> {
  /** Optional Standard JSON Schema input converter, used to infer CLI flags. */
  readonly jsonSchema?: {
    readonly input: (options: { readonly target: "draft-2020-12" }) => Record<string, unknown>;
  };
  readonly types?: { readonly input: TInput; readonly output: TOutput };
  readonly validate: (
    value: unknown,
    options?: { readonly libraryOptions?: Record<string, unknown> }
  ) => StandardSchemaV1Result<TOutput> | Promise<StandardSchemaV1Result<TOutput>>;
  readonly vendor: string;
  readonly version: 1;
}

/** Successful value or validation issues returned by a Standard Schema V1 validator. */
export type StandardSchemaV1Result<TOutput> =
  | { readonly issues?: undefined; readonly value: TOutput }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

/** Validation issue shape accepted from a Standard Schema V1 validator. */
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

/** Bounded JSON-safe snapshot of a thrown value and its cause chain. */
export interface PipelineErrorCause {
  cause?: PipelineErrorCause;
  message: string;
  name?: string;
  /** Machine-readable code copied from this cause, when present. */
  sourceCode?: string;
}

interface PipelineStepReportBase {
  /** Present once a supplied test output enters validation, including failed/cancelled attempts. */
  outputSource?: "override";
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

/** Terminal report for a successfully completed step. */
export interface PipelineStepCompleteReport extends PipelineStepReportBase {
  attemptId: string;
  startedAtMs: number;
  status: "completed";
}

/** Terminal report for a structurally or intentionally skipped step. */
export interface PipelineStepSkippedReport extends PipelineStepReportBase {
  /** Dependency that blocked this step, when applicable. */
  dependencyId?: string;
  /** Human-readable skip detail, especially for policy and fail-fast skips. */
  message?: string;
  reason: PipelineStepSkipReason;
  status: "skipped";
}

/** Terminal report for a cancelled step. */
export interface PipelineStepCancelledReport extends PipelineStepReportBase {
  error: PipelineError;
  status: "cancelled";
}

/** Terminal report for a failed step. */
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

/** Terminal status recorded in a step report. */
export type PipelineStepReportStatus = PipelineStepReport["status"];

/** Terminal disposition of a completed run record. */
export type PipelineRunStatus = "cancelled" | "completed" | "failed";

interface PipelineRunRecord {
  definitionIdentity?: PipelineDefinitionIdentity;
  /** Caller-owned identifier shared by related executions, when supplied. */
  correlationId?: string;
  pipelineId: string;
  dryRun: boolean;
  /** Run-level errors first, step errors in plan order, then finalization errors. */
  errors: PipelineError[];
  finishedAtMs: number;
  parentRunId?: string;
  runId: string;
  startedAtMs: number;
  status: PipelineRunStatus;
  /** Terminal step reports in stable plan order, independent of completion order. */
  steps: PipelineStepReport[];
  version: typeof RUN_MODEL_VERSION;
}

/** Versioned public record returned for one pipeline execution. */
export type PipelineRun<TResult = unknown> =
  | (PipelineRunRecord & {
      /** Finalization did not produce a result. Independent of terminal run status. */
      finalized: false;
      value?: undefined;
    })
  | (PipelineRunRecord & {
      /** Finalization produced a result. Independent of terminal run status. */
      finalized: true;
      value: TResult;
    });

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
 * Policy skips unlock required dependents. A bare-string skip (or a `{ reason }`
 * without `value`) makes dependents see `TOut | undefined`. When every skip
 * branch returns `{ reason, value }`, the step retains `TOut`; schema-backed
 * values use the schema input type and publish its transformed output type.
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
      /** Supplied test output; the normal step handler is not executing. */
      outputSource?: "override";
      progress?: PipelineStepProgress;
      status: "running";
      step: PipelinePlanStep;
    }
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepCancelledReport)
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepFailedReport)
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepSkippedReport)
  | ({ pipelineId: string; step: PipelinePlanStep } & PipelineStepCompleteReport);

/** Any planned, running, or terminal step lifecycle status. */
export type PipelineStepLifecycleStatus = PipelineStepStatus["status"];

/** Lifecycle event emitted when a step is planned. */
export type PipelineStepPlannedEvent = Extract<PipelineStepStatus, { status: "planned" }>;
type PipelineStepRunningStatus = Extract<PipelineStepStatus, { status: "running" }>;
/** Lifecycle event emitted when a step begins running. */
export type PipelineStepStartEvent = Omit<PipelineStepRunningStatus, "progress"> & {
  progress?: undefined;
};
/** Lifecycle event emitted when a running step reports progress. */
export type PipelineStepProgressEvent = Omit<PipelineStepRunningStatus, "progress"> & {
  progress: PipelineStepProgress;
};
/** Lifecycle event emitted when a step is cancelled. */
export type PipelineStepCancelledEvent = Extract<PipelineStepStatus, { status: "cancelled" }>;
/** Lifecycle event emitted when a step fails. */
export type PipelineStepFailedEvent = Extract<PipelineStepStatus, { status: "failed" }>;
/** Lifecycle event emitted when a step is skipped. */
export type PipelineStepSkippedEvent = Extract<PipelineStepStatus, { status: "skipped" }>;
/** Lifecycle event emitted when a step completes successfully. */
export type PipelineStepCompleteEvent = Extract<PipelineStepStatus, { status: "completed" }>;

/**
 * Optional lifecycle callbacks, each receiving its own metadata snapshot.
 * Domain result values retain their identity; hooks must treat them as read-only.
 */
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

/** Planned representation of one declared step and its selection state. */
export interface PipelinePlanStep {
  /** Declared agent capabilities and limits; future calls are not static steps. */
  agent?: PipelineDefinitionSnapshot["steps"][number]["agent"];
  dependencies: string[];
  description?: string;
  /** How this step behaves when the pipeline is run with `dryRun: true`. */
  dryRun: "custom" | "run" | "skip";
  id: string;
  /** Optional human-facing display name. Stable machine identity remains `id`. */
  name?: string;
  /** Static child structure when this opaque step executes another pipeline. */
  nestedPipeline?: {
    /** One child, runtime fan-out, or bounded sequential iteration. */
    mode: "single" | "for-each" | "iterate";
    /** Upper bound for a dynamically repeated child. */
    maxIterations?: number;
    /** Static child controls, recorded for iteration identity and inspection. */
    controls?: PipelineRunControls;
    identity?: PipelineDefinitionIdentity;
    concurrency?: number | "dynamic";
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

/** Side-effect-free validation and selection result for a pipeline run. */
export interface PipelinePlan {
  definition?: PipelineDefinitionSnapshot;
  dryRun: boolean;
  errors: PipelineError[];
  ok: boolean;
  pipelineId: string;
  steps: PipelinePlanStep[];
}

/** Layout directions for generated Mermaid flowcharts. */
export const PIPELINE_MERMAID_DIRECTIONS = ["BT", "LR", "RL", "TB", "TD"] as const;
/** Supported Mermaid flowchart direction. */
export type PipelineMermaidDirection = (typeof PIPELINE_MERMAID_DIRECTIONS)[number];

/** Rendering options for a pipeline Mermaid flowchart. */
export interface PipelineMermaidOptions {
  /** Mermaid flowchart direction. Defaults to top-down (`TD`). */
  direction?: PipelineMermaidDirection;
  /** Append each operational description to its node label. Defaults to false. */
  includeDescriptions?: boolean;
}

type PipelineRunArguments<
  TOptions,
  TStepId extends string,
  TTargetId extends string,
> = {} extends TOptions
  ? [
      options?: TOptions,
      controls?: PipelineRunControls<TStepId, TTargetId>,
      context?: Partial<PipelineContext>,
    ]
  : [
      options: TOptions,
      controls?: PipelineRunControls<TStepId, TTargetId>,
      context?: Partial<PipelineContext>,
    ];

/** Compiled pipeline that can be planned, executed, and rendered as a graph. */
export interface Pipeline<
  TOptions extends object,
  TResult,
  TStepId extends string = string,
  TTargetId extends string = TStepId,
  TId extends string = string,
> {
  readonly id: TId;
  /** Optional display name; stable identity remains `id`. */
  readonly name?: string;
  /** Human-readable purpose for command and discovery surfaces. */
  readonly description?: string;
  /** Compiled definition metadata. Absent only on externally implemented pipelines. */
  readonly definition?: PipelineDefinitionSnapshot;
  /** Runtime domain schema supplied to createSteps; CLI adapters can infer its input flags. */
  readonly optionsSchema?: StandardSchemaV1;
  /** Stable definition-order step ids for discovery surfaces such as CLI help. */
  readonly stepIds: readonly TStepId[];
  /** Stable declared goal ids that support dependency-aware target execution. */
  readonly targetIds: readonly TTargetId[];
  plan(controls?: PipelineRunControls<TStepId, TTargetId>): PipelinePlan;
  /** Omitted options default to {} when the input type has no required fields. */
  run(
    options: TOptions,
    controls?: PipelineRunControls<TStepId, TTargetId>,
    context?: Partial<PipelineContext>
  ): Promise<PipelineRun<TResult>>;
  run(...args: PipelineRunArguments<TOptions, TStepId, TTargetId>): Promise<PipelineRun<TResult>>;
  runOrThrow(
    options: TOptions,
    controls?: PipelineRunControls<TStepId, TTargetId>,
    context?: Partial<PipelineContext>
  ): Promise<TResult>;
  runOrThrow(...args: PipelineRunArguments<TOptions, TStepId, TTargetId>): Promise<TResult>;
  /** Generate a static Mermaid flowchart without running or planning the pipeline. */
  toMermaid(options?: PipelineMermaidOptions): string;
}

/** Input accepted by a pipeline run before any options schema transformation. */
export type PipelineInput<TPipeline extends Pipeline<object, unknown>> = Exclude<
  Parameters<TPipeline["run"]>[0],
  undefined
>;

/** Successful result produced by a pipeline run. */
export type PipelineResult<TPipeline extends Pipeline<object, unknown>> = Awaited<
  ReturnType<TPipeline["runOrThrow"]>
>;
