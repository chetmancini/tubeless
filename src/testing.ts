import { throwIfAborted } from "./abort.js";
import type {
  Pipeline,
  PipelineContext,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
  PipelineRunOptions,
  PipelineStepProgress,
  PipelineStepStatus,
} from "./pipeline.js";
import { hasVisibleStepProgress } from "./progress.js";

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
    options: PipelineRunOptions<TOptions, TStepId, TTargetId>
  ): Promise<PipelineRun<TResult>>;
  runOrThrow<TOptions extends object, TResult, TStepId extends string, TTargetId extends string>(
    pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
    options: PipelineRunOptions<TOptions, TStepId, TTargetId>
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
    run: (pipeline, runOptions) => pipeline.run(runOptions, context),
    runOrThrow: (pipeline, runOptions) => pipeline.runOrThrow(runOptions, context),
  };
}
