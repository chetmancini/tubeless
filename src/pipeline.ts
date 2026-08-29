import { abortableSleep } from "./abort.js";
import type { ToMappedChildStepProgressOptions } from "./mapped-child-progress.js";
import {
  createMappedChildRunner,
  createSingleChildRunner,
  type MappedChildExecutionConfig,
  type SingleChildExecutionConfig,
} from "./child-execution.js";
import { formatPipelineError } from "./pipeline-diagnostics.js";
import {
  executePlannedRun,
  isPipelineCancellation,
  PipelineExecutionError,
} from "./pipeline-execute.js";
import { createRunId, RUN_MODEL_VERSION } from "./pipeline-ids.js";
import {
  PIPELINE_FINALIZE_STEP_ID,
  REQUIRED_FINALIZER_OUTPUTS,
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  buildPipelinePlan,
  renderPipelineMermaid,
  topologicalSort,
  validatePipelineDefinition,
} from "./pipeline-plan.js";
import type { StepIds, StepsInputOptions, StepsOptions, TargetIds } from "./pipeline-plan.js";
import type {
  PipelineTraceAttributes,
  PipelineTraceContext,
  PipelineTracingOptions,
} from "./tracing.js";

export { createRunId, PIPELINE_FINALIZE_STEP_ID, PipelineExecutionError, RUN_MODEL_VERSION };

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

/** Domain input plus the built-in controls for one pipeline invocation. */
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

const fallbackNow = (): number => Date.now();

const fallbackSleep = (durationMs: number, signal?: AbortSignal): Promise<void> =>
  abortableSleep(durationMs, signal, "Pipeline sleep");

export function defaultPipelineContext(): PipelineContext {
  return { cwd: process.cwd(), log: console, now: fallbackNow, sleep: fallbackSleep };
}

/** Programmer error raised immediately when a pipeline graph is invalid. */
export class PipelineDefinitionError extends Error {
  constructor(
    readonly pipelineId: string,
    readonly errors: readonly PipelineError[]
  ) {
    super(
      errors.length > 0
        ? `Invalid pipeline ${pipelineId}: ${errors.map((error) => formatPipelineError(error)).join("; ")}`
        : `Invalid pipeline ${pipelineId}`
    );
    this.name = "PipelineDefinitionError";
  }
}

const PIPELINE_RUN_CONTROL_KEYS = ["continueOnError", "dryRun", "stepIds", "targets"] as const;

function isPipelineRunControlKey(
  property: PropertyKey
): property is (typeof PIPELINE_RUN_CONTROL_KEYS)[number] {
  return (
    typeof property === "string" &&
    // SAFETY: `includes` membership over the literal tuple guarantees the cast
    // target is exactly one of the declared run-control keys.
    PIPELINE_RUN_CONTROL_KEYS.includes(property as (typeof PIPELINE_RUN_CONTROL_KEYS)[number])
  );
}

function createDomainOptionsTarget<TOptions extends object>(options: TOptions): object {
  const descriptors = Object.fromEntries(
    Reflect.ownKeys(options)
      .filter((property) => !isPipelineRunControlKey(property))
      .map((property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(options, property)!;
        return [property, { ...descriptor, configurable: true }];
      })
  );
  // SAFETY: `Object.create` returns the same prototype shape as `options` with
  // only its own enumerable descriptors re-applied, so it remains assignable
  // to the caller's `object` contract.
  return Object.create(Object.getPrototypeOf(options), descriptors) as object;
}

function createDomainOptionsView<TOptions extends object>(options: TOptions): TOptions {
  const target = createDomainOptionsTarget(options);
  const boundMethods = new WeakMap<object, unknown>();
  // SAFETY: the Proxy wraps the domain-options target and forwards to the
  // original options, so its surface is assignable to `TOptions`.
  return new Proxy(target, {
    get(_target, property) {
      if (isPipelineRunControlKey(property)) return undefined;
      // SAFETY: `property` is a non-control key, so indexing the options object
      // with it reads a genuine domain property; the cast is the only way to
      // express dynamic-key access on a generic options type.
      const value = options[property as keyof TOptions];
      if (typeof value !== "function") return value;
      const cached = boundMethods.get(value);
      if (cached) return cached;
      const bound = value.bind(options);
      boundMethods.set(value, bound);
      return bound;
    },
    has(_target, property) {
      return isPipelineRunControlKey(property) ? false : Reflect.has(options, property);
    },
    set(_target, property, value) {
      if (isPipelineRunControlKey(property)) return true;
      return Reflect.set(options, property, value, options);
    },
    // SAFETY: the Proxy target is the domain-options object, so it is
    // assignable to the caller's `TOptions` contract.
  }) as TOptions;
}

type SplitPipelineRunOptionsResult<
  TOptions extends object,
  TStepId extends string,
  TTargetId extends string,
> = {
  controls: PipelineRunControls<TStepId, TTargetId>;
  domainOptions: TOptions;
};

function splitPipelineRunOptions<
  TOptions extends object,
  TStepId extends string,
  TTargetId extends string,
>(
  options: PipelineRunOptions<TOptions, TStepId, TTargetId>
): SplitPipelineRunOptionsResult<TOptions, TStepId, TTargetId> {
  const controls: PipelineRunControls<TStepId, TTargetId> = {};
  let hasControls = false;
  for (const key of PIPELINE_RUN_CONTROL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
    hasControls = true;
    Object.assign(controls, { [key]: options[key] });
  }
  return {
    controls,
    domainOptions: hasControls ? createDomainOptionsView<TOptions>(options) : options,
  };
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
    options: PipelineRunOptions<TOptions, TStepId, TTargetId>,
    context?: Partial<PipelineContext>
  ): Promise<PipelineRun<TResult>>;
  runOrThrow(
    options: PipelineRunOptions<TOptions, TStepId, TTargetId>,
    context?: Partial<PipelineContext>
  ): Promise<TResult>;
  /** Generate a static Mermaid flowchart without running or planning the pipeline. */
  toMermaid(options?: PipelineMermaidOptions): string;
}

/**
 * A step's dependencies are references to the dependency's own step object, not string ids
 * into a hand-maintained output-type map. This buys two things no amount of extra generics
 * on a string-keyed design could:
 *  - a step used before its dependency exists is a compile error (JS temporal dead zone on
 *    `const`), so out-of-order and self/cyclic dependencies are caught by the language, not
 *    a bespoke runtime check
 *  - each step only ever states its own id/deps; the output-type map is derived, never
 *    restated, and callers of `definePipeline`/`createSteps` never write out its generics
 */
type AnyStepDryRunHandler<TOptions extends object> = {
  bivarianceHack(
    inputs: Record<string, unknown>,
    context: PipelineStepContext<TOptions>
  ): unknown | Promise<unknown>;
}["bivarianceHack"];

export interface AnyStep<TOptions extends object = object> {
  readonly [STEP_NESTED_PIPELINE]?: NonNullable<PipelinePlanStep["nestedPipeline"]>;
  readonly [STEP_OPTIONS_SCHEMA]?: StandardSchemaV1;
  readonly id: string;
  readonly dependsOn?: readonly AnyStep<TOptions>[];
  readonly optionalDependsOn?: readonly AnyStep<TOptions>[];
  readonly skipAfterFailureOf?: readonly AnyStep<TOptions>[];
  /** Optional human-facing display name. Stable machine identity remains `id`. */
  readonly name?: string;
  readonly description?: string;
  /**
   * Dry-run policy. Omitted runs the normal handler, `"skip"` structurally
   * skips it, and a handler substitutes for `run` while preserving its output.
   */
  readonly dryRun?: "skip" | AnyStepDryRunHandler<TOptions>;
  /** Optional Standard Schema for values published by this step. */
  readonly outputSchema?: StandardSchemaV1;
  /**
   * Optional runtime skip. Return a non-empty reason (or `{ reason, value }`) to
   * skip without calling `run`. Policy skips unlock dependents; structural skips
   * (dry-run, filtered, …) do not use this hook.
   */
  skip?(
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<TOptions>
  ): StepSkipDecision | Promise<StepSkipDecision>;
  run(inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>): unknown;
}

/** The step fields that `buildStep` merges onto the id-bearing shell. */
type StepDefinitionBody<TOptions extends object> = Omit<AnyStep<TOptions>, "id">;

export interface Step<
  TId extends string,
  TOut,
  TOptions extends object,
  TInputOptions extends object = TOptions,
  TRunOut = TOut,
> extends AnyStep<TOptions> {
  readonly id: TId;
  run(
    inputs: Record<string, unknown>,
    context: PipelineStepContext<TOptions>
  ): TRunOut | Promise<TRunOut>;
  /** Type-only: carries this step's output type for sibling inference. Never set at runtime. */
  readonly __outputType?: TOut;
  /** Type-only: carries pre-validation run options for pipeline call-site inference. */
  readonly __inputOptionsType?: TInputOptions;
}

/**
 * Extract a step's output type for dependency typing.
 * Prefer matching `Step<…, TOut, …>` over `{ __outputType?: infer T }`: optional-property
 * inference collapses `TOut | undefined` to `TOut`, which hides policy-skip widening.
 */
type StepOutput<S> =
  S extends Step<string, infer TOut, infer _TOptions, infer _TInputOptions, infer _TRunOut>
    ? TOut
    : never;

interface StepToken {
  readonly id: string;
  readonly __outputType?: unknown;
}

type RequiredInputs<TDeps extends readonly StepToken[]> = {
  [S in TDeps[number] as S["id"]]: StepOutput<S>;
};

type OptionalInputs<TDeps extends readonly StepToken[]> = {
  [S in TDeps[number] as S["id"]]?: StepOutput<S>;
};

type PipelineResultOf<TPipeline> =
  TPipeline extends Pipeline<object, infer TResult, infer _TStepId, infer _TTargetId>
    ? TResult
    : never;

type PipelineRunOptionsOf<TPipeline> =
  TPipeline extends Pipeline<infer TOptions, unknown, infer TStepId, infer TTargetId>
    ? PipelineRunOptions<TOptions, TStepId, TTargetId>
    : never;

type ChildPipelineStepDefinitionBase<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TChildPipeline extends Pipeline<object, unknown>,
> = {
  pipeline: TChildPipeline;
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TParentOptions>[];
  name?: string;
  description?: string;
  dryRun?: "skip";
  mapOptions(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineRunOptionsOf<TChildPipeline>;
};

/** Child step without policy skip (dependents see the full child result type). */
type ChildPipelineStepDefinition<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TChildPipeline extends Pipeline<object, unknown>,
> = ChildPipelineStepDefinitionBase<TParentOptions, TDeps, TOptionalDeps, TChildPipeline>;

/**
 * Presentation options for opaque `forEachPipeline` progress.
 * Defaults are domain-neutral (`N/M items · K running · key/step`).
 * Override `formatMessage` when a domain wants its own noun (images, shards, …).
 */
export type MappedChildProgressOptions = ToMappedChildStepProgressOptions;

type MappedChildPipelineStepDefinition<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TChildPipeline extends Pipeline<object, unknown>,
  TItem,
> = {
  pipeline: TChildPipeline;
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TParentOptions>[];
  name?: string;
  description?: string;
  dryRun?: "skip";
  items(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): readonly TItem[] | Promise<readonly TItem[]>;
  key(item: TItem, index: number): string;
  concurrency?:
    | number
    | ((
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineExecutionContext<TParentOptions>
      ) => number);
  /**
   * How the opaque parent step reports live fan-out progress.
   * Purely presentational — does not change scheduling or results.
   */
  progress?: MappedChildProgressOptions;
  mapOptions(
    item: TItem,
    index: number,
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineRunOptionsOf<TChildPipeline>;
};

type StepSkipPredicate<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
> = (
  inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
  context: PipelineExecutionContext<TOptions>
) => StepSkipDecision<TOut> | Promise<StepSkipDecision<TOut>>;

type StepDryRunPolicy<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
> =
  | "skip"
  | ((
      inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
      context: PipelineStepContext<TOptions>
    ) => TOut | Promise<TOut>);

type PlainStepFields<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
> = {
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TOptions>[];
  name?: string;
  description?: string;
  dryRun?: StepDryRunPolicy<TOptions, TDeps, TOptionalDeps, TOut>;
  outputSchema?: never;
  run(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineStepContext<TOptions>
  ): TOut | Promise<TOut>;
};

type SchemaStepFields<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TSchema extends StandardSchemaV1,
> = Omit<
  PlainStepFields<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>,
  "outputSchema"
> & {
  outputSchema: TSchema;
};

interface StepConstructor<TOptions extends object, TInputOptions extends object = TOptions> {
  /** Ordinary steps never policy-skip, so dependents receive their full output. */
  <
    TId extends string,
    TSchema extends StandardSchemaV1,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: SchemaStepFields<TOptions, TDeps, TOptionalDeps, TSchema> & { skip?: never }
  ): Step<TId, InferSchemaOutput<TSchema>, TOptions, TInputOptions, InferSchemaInput<TSchema>>;

  <
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TOut = unknown,
  >(
    id: TId,
    definition: PlainStepFields<TOptions, TDeps, TOptionalDeps, TOut> & { skip?: never }
  ): Step<TId, TOut, TOptions, TInputOptions>;

  /** Explicit policy-skip constructor; dependents receive `TOut | undefined`. */
  skippable: SkippableStepConstructor<TOptions, TInputOptions>;
}

interface SkippableStepConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
    TId extends string,
    TSchema extends StandardSchemaV1,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: SchemaStepFields<TOptions, TDeps, TOptionalDeps, TSchema> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>
        | undefined;
    }
  ): Step<
    TId,
    InferSchemaOutput<TSchema> | undefined,
    TOptions,
    TInputOptions,
    InferSchemaInput<TSchema>
  >;

  <
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TOut = unknown,
  >(
    id: TId,
    definition: PlainStepFields<TOptions, TDeps, TOptionalDeps, TOut> & {
      skip: StepSkipPredicate<TOptions, TDeps, TOptionalDeps, TOut> | undefined;
    }
  ): Step<TId, TOut | undefined, TOptions, TInputOptions>;
}

interface FromPipelineConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinition<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip?: never;
      mapResult?: undefined;
    }
  ): Step<TId, PipelineResultOf<TChildPipeline>, TOptions, TInputOptions>;

  <
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip?: never;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): Step<TId, TOut, TOptions, TInputOptions>;

  skippable: SkippableFromPipelineConstructor<TOptions, TInputOptions>;
}

interface SkippableFromPipelineConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, PipelineResultOf<TChildPipeline>>
        | undefined;
      mapResult?: undefined;
    }
  ): Step<TId, PipelineResultOf<TChildPipeline> | undefined, TOptions, TInputOptions>;

  <
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip: StepSkipPredicate<TOptions, TDeps, TOptionalDeps, NoInfer<TOut>> | undefined;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): Step<TId, TOut | undefined, TOptions, TInputOptions>;
}

export interface StepFactory<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> extends StepConstructor<TOptions, TInputOptions> {
  fromPipeline: FromPipelineConstructor<TOptions, TInputOptions>;

  forEachPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TItem,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: MappedChildPipelineStepDefinition<
      TOptions,
      TDeps,
      TOptionalDeps,
      TChildPipeline,
      TItem
    > & {
      mapResult?: undefined;
    }
  ): Step<TId, readonly PipelineResultOf<TChildPipeline>[], TOptions, TInputOptions>;

  forEachPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TItem,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: MappedChildPipelineStepDefinition<
      TOptions,
      TDeps,
      TOptionalDeps,
      TChildPipeline,
      TItem
    > & {
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        item: TItem,
        index: number,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): Step<TId, readonly TOut[], TOptions, TInputOptions>;
}

/**
 * Returns a step factory scoped to one pipeline's domain options. Built-in run
 * controls are accepted alongside those options when the pipeline is invoked.
 */
export function createSteps<TOptions extends object = {}>(): StepFactory<TOptions>;
export function createSteps<const TSchema extends StandardSchemaV1<object, object>>(
  optionsSchema: TSchema
): StepFactory<InferSchemaOutput<TSchema>, InferSchemaInput<TSchema>>;
export function createSteps(optionsSchema?: StandardSchemaV1<object, object>): StepFactory<object> {
  return createStepFactory<object>(optionsSchema);
}

function createStepFactory<TOptions extends object, TInputOptions extends object = TOptions>(
  optionsSchema?: StandardSchemaV1
): StepFactory<TOptions, TInputOptions> {
  // Runtime construction is deliberately simple; the public factory owns the
  // distinction between ordinary and explicitly skippable constructors.
  const buildStep = (id: string, definition: StepDefinitionBody<TOptions>): AnyStep<TOptions> => {
    // SAFETY: `definition` carries the step's own fields; spreading it onto the
    // id-bearing shell yields a value whose shape matches `AnyStep<TOptions>`.
    const built = { id, ...definition } as AnyStep<TOptions>;
    if (optionsSchema) {
      Object.defineProperty(built, STEP_OPTIONS_SCHEMA, { value: optionsSchema });
    }
    return built;
  };

  // SAFETY: the closure's parameter and return shapes match the
  // `fromPipeline` constructor signature it is assigned to.
  const fromPipeline = ((
    id: string,
    config: ChildPipelineStepDefinitionBase<
      TOptions,
      readonly AnyStep<TOptions>[],
      readonly AnyStep<TOptions>[],
      Pipeline<object, unknown>
    > & {
      skip?: StepSkipPredicate<
        TOptions,
        readonly AnyStep<TOptions>[],
        readonly AnyStep<TOptions>[],
        unknown
      >;
      mapResult?: (
        value: unknown,
        result: PipelineRun<unknown>,
        context: PipelineStepContext<TOptions>
      ) => unknown;
    }
  ) => {
    const definition = {
      [STEP_NESTED_PIPELINE]: {
        mode: "single" as const,
        pipelineId: config.pipeline.id,
        stepIds: config.pipeline.stepIds,
      },
      dependsOn: config.dependsOn,
      optionalDependsOn: config.optionalDependsOn,
      skipAfterFailureOf: config.skipAfterFailureOf,
      name: config.name,
      description: config.description,
      dryRun: config.dryRun,
      // SAFETY: the config carries `pipeline` and `mapResult`; the runner
      // derives `mapOptions` from the same fields, so the config is a valid
      // single-child execution config at runtime.
      run: createSingleChildRunner(config as SingleChildExecutionConfig<TOptions>, {
        createExecutionError: (result, message) => new PipelineExecutionError(result, message),
        isCancellation: (error, childContext) => isPipelineCancellation(error, childContext),
      }),
    };

    if ("skip" in config && config.skip !== undefined) {
      const skip = config.skip;
      // SAFETY: the skip predicate is invoked with the step's own inputs and
      // returns a step-skip decision; the casts only align the generic
      // predicate signature with the concrete step context.
      return buildStep(id, {
        ...definition,
        skip: (
          inputs: RequiredInputs<readonly AnyStep<TOptions>[]> &
            OptionalInputs<readonly AnyStep<TOptions>[]>,
          context: PipelineExecutionContext<TOptions>
        ) => skip(inputs as never, context) as StepSkipDecision | Promise<StepSkipDecision>,
      });
    }
    return buildStep(id, definition);
  }) as StepFactory<TOptions, TInputOptions>["fromPipeline"];

  // SAFETY: the closure's parameter and return shapes match the
  // `forEachPipeline` constructor signature it is assigned to.
  const forEachPipeline = ((
    id: string,
    config: MappedChildPipelineStepDefinition<
      TOptions,
      readonly AnyStep<TOptions>[],
      readonly AnyStep<TOptions>[],
      Pipeline<object, unknown>,
      unknown
    > & {
      mapResult?: (
        value: unknown,
        result: PipelineRun<unknown>,
        item: unknown,
        index: number,
        context: PipelineStepContext<TOptions>
      ) => unknown;
    }
  ) =>
    buildStep(id, {
      [STEP_NESTED_PIPELINE]: {
        mode: "for-each" as const,
        pipelineId: config.pipeline.id,
        stepIds: config.pipeline.stepIds,
      },
      dependsOn: config.dependsOn,
      optionalDependsOn: config.optionalDependsOn,
      skipAfterFailureOf: config.skipAfterFailureOf,
      name: config.name,
      description: config.description,
      dryRun: config.dryRun,
      // SAFETY: the config carries `pipeline`, `items`, `key`, and `mapResult`;
      // the runner derives the rest from those fields, so the config is a valid
      // mapped-child execution config at runtime.
      run: createMappedChildRunner(config as MappedChildExecutionConfig<TOptions>, {
        createExecutionError: (result, message) => new PipelineExecutionError(result, message),
        isCancellation: (error, childContext) => isPipelineCancellation(error, childContext),
      }),
    })) as StepFactory<TOptions, TInputOptions>["forEachPipeline"];

  // SAFETY: `buildStep` is a callable; attaching the constructor properties
  // yields exactly the `StepFactory` surface (call + skippable + fromPipeline +
  // forEachPipeline), so the single assertion is sound.
  const factory = Object.assign(buildStep, {
    skippable: buildStep,
    fromPipeline,
    forEachPipeline,
  }) as StepFactory<TOptions, TInputOptions>;
  // SAFETY: `fromPipeline` is the same callable as `factory.fromPipeline`; it
  // carries the skippable variant, so the assignment is sound.
  factory.fromPipeline.skippable = fromPipeline as StepFactory<
    TOptions,
    TInputOptions
  >["fromPipeline"]["skippable"];

  return factory;
}

type PipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]: StepOutput<S>;
};

type RequiredPipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]-?: StepOutput<S>;
};

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
  const requiredFinalizer = (
    outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
    context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
  ) => {
    const missingStepIds = uniqueRequiredSteps
      .filter((step) => !Object.prototype.hasOwnProperty.call(outputs, step.id))
      .map((step) => step.id);
    if (missingStepIds.length > 0) {
      throw new Error(`Required pipeline outputs missing: ${missingStepIds.join(", ")}`);
    }
    // SAFETY: every required step id was verified present above, so the partial
    // outputs contain all required keys and are a complete required-outputs map.
    return finalize(outputs as unknown as RequiredPipelineOutputs<TRequiredSteps>, context);
  };
  Object.defineProperty(requiredFinalizer, REQUIRED_FINALIZER_OUTPUTS, {
    value: uniqueRequiredSteps,
  });
  return requiredFinalizer;
}

export interface PipelineDefinition<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][] = readonly [],
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
  id: string;
  steps: TSteps;
  /** Public downstream goals that callers may select with `targets`. */
  targets?: TTargets;
  /** Optional Standard Schema for the finalized result. */
  resultSchema?: TResultSchema;
  finalize(
    outputs: Partial<PipelineOutputs<TSteps>>,
    context: PipelineExecutionContext<StepsOptions<TSteps>>
  ):
    | (TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult)
    | Promise<TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult>;
}

function resolvePipelineRuntime(context: Partial<PipelineContext> = {}): PipelineRuntime {
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
