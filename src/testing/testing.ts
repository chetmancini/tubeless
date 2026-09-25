import type { AnyStep } from "../core/pipeline-steps.js";
import { throwIfAborted } from "../utilities/abort.js";
import { EXECUTE_TEST_RUN, isCompiledPipeline } from "../core/pipeline-identity.js";
import { PipelineExecutionError } from "../core/pipeline-execution-error.js";
import type {
  Pipeline,
  PipelineContext,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
  PipelineStepProgress,
  PipelineStepStatus,
} from "../core/pipeline.js";
import { hasVisibleStepProgress } from "../core/progress.js";

const overrideValue: unique symbol = Symbol("pipelineTestOverride");

/** A typed step/value pair created by overrideStep; only accepted by test runs. */
export interface PipelineTestOverride {
  readonly [overrideValue]: { readonly step: AnyStep; readonly value: unknown };
}

/** Supply a resolved handler output, before the step's outputSchema validation/transformation. */
export function overrideStep<TStep extends AnyStep>(
  step: TStep,
  value: NoInfer<Awaited<ReturnType<TStep["run"]>>>
): PipelineTestOverride {
  return Object.freeze({ [overrideValue]: Object.freeze({ step, value }) });
}

/** Test-only controls. Overrides never select steps or propagate into child runs. */
export type PipelineTestRunControls<
  TStepId extends string = string,
  TTargetId extends string = string,
> = PipelineRunControls<TStepId, TTargetId> & {
  overrides?: readonly PipelineTestOverride[];
};

type TestExecutable<
  TOptions extends object,
  TResult,
  TStepId extends string,
  TTargetId extends string,
> = {
  [EXECUTE_TEST_RUN](
    options: TOptions,
    controls: PipelineRunControls<TStepId, TTargetId>,
    context: PipelineContext,
    overrides: ReadonlyMap<AnyStep, unknown>
  ): Promise<PipelineRun<TResult>>;
};

async function runWithOverrides<
  TOptions extends object,
  TResult,
  TStepId extends string,
  TTargetId extends string,
>(
  pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
  options: TOptions,
  controls: PipelineTestRunControls<TStepId, TTargetId> | undefined,
  context: PipelineContext
): Promise<PipelineRun<TResult>> {
  if (!controls?.overrides?.length) return pipeline.run(options, controls, context);
  if (!isCompiledPipeline(pipeline))
    throw new TypeError("Step overrides require a pipeline returned by definePipeline");
  const overrides = new Map<AnyStep, unknown>();
  for (const entry of controls.overrides) {
    const pair = entry?.[overrideValue];
    if (!pair) throw new TypeError("Step overrides must be created by overrideStep");
    if (overrides.has(pair.step))
      throw new TypeError(`Duplicate override for step ${pair.step.id}`);
    overrides.set(pair.step, pair.value);
  }
  // SAFETY: definePipeline brands the exact object and installs this internal entrypoint.
  const executable = pipeline as typeof pipeline &
    TestExecutable<TOptions, TResult, TStepId, TTargetId>;
  return executable[EXECUTE_TEST_RUN](options, controls, context, overrides);
}

/** Log levels captured by a pipeline test runtime. */
export type PipelineTestLogLevel = "error" | "log" | "warn";

/** One silent logger call captured by a pipeline test runtime. */
export interface PipelineTestLogEntry {
  args: readonly unknown[];
  level: PipelineTestLogLevel;
  message: unknown;
}

/** Monotonic caller-controlled clock used by a pipeline test runtime. */
export interface PipelineTestClock {
  readonly timeMs: number;
  advance(durationMs: number): number;
  now(): number;
}

/** Optional replacement for the default immediate, clock-advancing test sleep. */
export type PipelineTestSleep = (
  durationMs: number,
  signal: AbortSignal | undefined,
  clock: PipelineTestClock
) => void | Promise<void>;

/** Clock, directory, and sleep overrides for a pipeline test runtime. */
export interface PipelineTestRuntimeOptions {
  /** Runtime working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Initial clock value. Defaults to zero. */
  startTimeMs?: number;
  /** Customize deterministic sleep behavior. */
  sleep?: PipelineTestSleep;
}

/** Framework-neutral runtime, observations, and typed execution helpers for pipeline tests. */
export interface PipelineTestRuntime {
  readonly abortController: AbortController;
  readonly clock: PipelineTestClock;
  readonly context: PipelineContext;
  readonly latestProgress: ReadonlyMap<string, PipelineStepProgress>;
  readonly logs: readonly PipelineTestLogEntry[];
  readonly statuses: readonly PipelineStepStatus[];
  abort(reason?: unknown): void;
  plan<TOptions extends object, TResult, TStepId extends string, TTargetId extends string>(
    pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
    controls?: PipelineRunControls<TStepId, TTargetId>
  ): PipelinePlan;
  run<TOptions extends object, TResult, TStepId extends string, TTargetId extends string>(
    pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
    options: TOptions,
    controls?: PipelineTestRunControls<TStepId, TTargetId>
  ): Promise<PipelineRun<TResult>>;
  runOrThrow<TOptions extends object, TResult, TStepId extends string, TTargetId extends string>(
    pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
    options: TOptions,
    controls?: PipelineTestRunControls<TStepId, TTargetId>
  ): Promise<TResult>;
}

function createTestClock(startTimeMs: number): PipelineTestClock {
  if (!Number.isFinite(startTimeMs)) {
    throw new RangeError("Pipeline test clock start time must be finite.");
  }
  let timeMs = startTimeMs;
  return {
    get timeMs() {
      return timeMs;
    },
    advance(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new RangeError(
          "Pipeline test clock advancement must be a finite non-negative number."
        );
      }
      timeMs += durationMs;
      return timeMs;
    },
    now: () => timeMs,
  };
}

/** Create a deterministic runtime without installing a test framework or fake-timer package. */
export function createPipelineTestRuntime(
  options: PipelineTestRuntimeOptions = {}
): PipelineTestRuntime {
  const abortController = new AbortController();
  const clock = createTestClock(options.startTimeMs ?? 0);
  const latestProgress = new Map<string, PipelineStepProgress>();
  const logs: PipelineTestLogEntry[] = [];
  const statuses: PipelineStepStatus[] = [];

  const captureLog =
    (level: PipelineTestLogLevel): PipelineLogger[PipelineTestLogLevel] =>
    (message?: unknown, ...args: unknown[]) => {
      logs.push({ args, level, message });
    };
  const log: PipelineLogger = {
    error: captureLog("error"),
    log: captureLog("log"),
    warn: captureLog("warn"),
  };
  const hooks: PipelineHooks = {
    onStepStatus: (status) => {
      statuses.push(status);
      if (
        status.status === "running" &&
        status.progress &&
        hasVisibleStepProgress(status.progress)
      ) {
        latestProgress.set(status.step.id, status.progress);
      }
    },
  };
  const sleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
    throwIfAborted(signal, "Pipeline test sleep");
    if (options.sleep) {
      await options.sleep(durationMs, signal, clock);
    } else if (durationMs > 0) {
      clock.advance(durationMs);
    }
    throwIfAborted(signal, "Pipeline test sleep");
  };
  const context: PipelineContext = {
    cwd: options.cwd ?? process.cwd(),
    hooks,
    log,
    now: clock.now,
    signal: abortController.signal,
    sleep,
  };

  return {
    abortController,
    clock,
    context,
    latestProgress,
    logs,
    statuses,
    abort(reason) {
      if (reason === undefined) abortController.abort();
      else abortController.abort(reason);
    },
    plan: (pipeline, controls) => pipeline.plan(controls),
    run: (pipeline, runOptions, controls) =>
      runWithOverrides(pipeline, runOptions, controls, context),
    runOrThrow: async (pipeline, runOptions, controls) => {
      if (!controls?.overrides?.length) return pipeline.runOrThrow(runOptions, controls, context);
      const result = await runWithOverrides(pipeline, runOptions, controls, context);
      if (result.status !== "completed") throw new PipelineExecutionError(result);
      // SAFETY: a successful run always finalized its typed result.
      return result.value as Awaited<ReturnType<typeof pipeline.runOrThrow>>;
    },
  };
}
