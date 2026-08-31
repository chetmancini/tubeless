import { format } from "node:util";
import type {
  PipelineError,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelineRun,
  PipelineStepProgress,
  PipelineStepStatus,
} from "./pipeline.js";
import { hasVisibleStepProgress } from "./progress.js";
import {
  createLiveTicker,
  elapsedToken,
  shimmerToken,
  SPINNER_TOKEN,
  type LiveTicker,
} from "./live-ticker.js";
import {
  createReporterTheme,
  createRunReporter,
  formatDurationMs,
  type ReporterTheme,
  type RunReporterConfig,
} from "./reporter.js";

export type PipelineReporterMode = "auto" | "interactive" | "plain";
export type ResolvedPipelineReporterMode = Exclude<PipelineReporterMode, "auto">;

export interface ReporterOutput {
  readonly columns?: number;
  /**
   * File descriptor for live frames. When set, spinner, elapsed time, and shimmer
   * paint on a worker thread so they keep moving during CPU-bound steps. Defaults
   * to stdout's fd when `output` is `process.stdout`.
   */
  readonly fd?: number;
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface PipelineReporterConfig extends RunReporterConfig {
  /** Auto selects the interactive renderer only for a capable, non-CI TTY. */
  mode?: PipelineReporterMode;
  /** Terminal stream used by the interactive renderer. Defaults to stdout. */
  output?: ReporterOutput;
  /** Spinner redraw cadence. Defaults to 80ms. */
  refreshIntervalMs?: number;
  /** Filled/empty character width for determinate progress. Defaults to 20. */
  progressBarWidth?: number;
}

export interface PipelineReporterOptions extends PipelineReporterConfig {
  log: PipelineLogger;
}

export interface PipelineReporterController<TResult = unknown> {
  readonly hooks: PipelineHooks<TResult>;
  readonly log: PipelineLogger;
  readonly mode: ResolvedPipelineReporterMode;
  /** Stop redraws and restore terminal state. Safe to call more than once. */
  dispose(): void;
}

type StepState = PipelineStepStatus & {
  /** Wall-clock ms from Date.now() when the step entered the running state. */
  startedAtMs?: number;
};

type FinalizeState =
  | { status: "idle" }
  | { status: "running" }
  | { durationMs: number; status: "completed" }
  | { durationMs: number; error: PipelineError; status: "failed" };

const TERMINAL_OSC = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const TERMINAL_STRING = /(?:\u001B[P_X^]|\u0090|\u0098|\u009E|\u009F)[\s\S]*?(?:\u001B\\|\u009C)/g;
const TERMINAL_CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const TERMINAL_ESCAPE = /\u001B[@-_]/g;
const TERMINAL_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

function autoInteractiveAllowed(output: ReporterOutput, config: PipelineReporterConfig): boolean {
  const isTTY = config.terminal?.isTTY ?? output.isTTY === true;
  const ci = process.env.CI;
  const isCI = ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
  return isTTY && process.env.TERM !== "dumb" && !isCI;
}

function resolveMode(
  output: ReporterOutput,
  config: PipelineReporterConfig
): ResolvedPipelineReporterMode {
  if (config.mode === "interactive") return "interactive";
  if (config.mode === "plain") return "plain";
  return autoInteractiveAllowed(output, config) ? "interactive" : "plain";
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(TERMINAL_OSC, "")
    .replace(TERMINAL_STRING, "")
    .replace(TERMINAL_CSI, "")
    .replace(TERMINAL_ESCAPE, "")
    .replace(TERMINAL_CONTROL, "");
}

function safeTerminalText(value: string): string {
  return stripTerminalControls(value.replace(/\s+/g, " ")).trim();
}

function safeTerminalLog(value: string): string {
  return stripTerminalControls(value.replace(/\r\n?/g, "\n").replaceAll("\t", " "));
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderProgress(progress: PipelineStepProgress, width: number, unicode: boolean): string {
  // Parent line keeps the summary message only; per-item work uses `details`.
  const message = progress.message ? ` ${safeTerminalText(progress.message)}` : "";
  if (progress.total === undefined || safeNumber(progress.total) <= 0) {
    return `${formatCount(safeNumber(progress.completed))}${message}`;
  }
  const completed = safeNumber(progress.completed);
  const total = safeNumber(progress.total);
  const ratio = Math.max(0, Math.min(1, completed / total));
  const filled = Math.round(ratio * width);
  const bar = `${unicode ? "█".repeat(filled) : "=".repeat(filled)}${
    unicode ? "░".repeat(width - filled) : "-".repeat(width - filled)
  }`;
  return `[${bar}] ${Math.round(ratio * 100)}% ${formatCount(completed)}/${formatCount(total)}${message}`;
}

function renderProgressDetail(
  detail: NonNullable<PipelineStepProgress["details"]>[number],
  theme: ReporterTheme,
  spinner: string
): string {
  const status = detail.status ?? "running";
  const symbol =
    status === "completed"
      ? theme.styled.complete(theme.symbols.complete)
      : status === "failed"
        ? theme.styled.fail(theme.symbols.fail)
        : status === "skipped"
          ? theme.styled.skip(theme.symbols.skip)
          : status === "pending"
            ? theme.styled.description(theme.symbols.pending)
            : theme.styled.start(spinner);
  const id = safeTerminalText(detail.id);
  const labelText = detail.label ? safeTerminalText(detail.label) : "";
  const running =
    status !== "completed" && status !== "failed" && status !== "skipped" && status !== "pending";
  const body = labelText ? `${id} ${labelText}` : id;
  const paintedBody =
    running && theme.colorEnabled
      ? shimmerToken(body)
      : `${id}${labelText ? ` ${theme.styled.description(labelText)}` : ""}`;
  return `    ${symbol} ${paintedBody}`;
}

function renderStep(
  state: StepState,
  theme: ReporterTheme,
  spinner: string,
  progressBarWidth: number
): string[] {
  const { step } = state;
  const displayName = safeTerminalText(step.name ?? step.id);
  switch (state.status) {
    case "running": {
      const progress =
        state.progress && hasVisibleStepProgress(state.progress)
          ? ` ${renderProgress(state.progress, progressBarWidth, theme.capabilities.unicode)}`
          : "";
      const elapsed =
        state.startedAtMs !== undefined
          ? ` ${theme.styled.duration(elapsedToken(state.startedAtMs))}`
          : "";
      const lines = [
        `  ${theme.styled.start(spinner)} ${shimmerToken(displayName)}${progress}${elapsed}`,
      ];
      const details = state.progress?.details;
      if (details && details.length > 0) {
        for (const detail of details) {
          lines.push(renderProgressDetail(detail, theme, spinner));
        }
      }
      return lines;
    }
    case "completed":
      return [
        `  ${theme.styled.complete(theme.symbols.complete)} ${displayName} ${theme.styled.duration(
          `(${formatDurationMs(state.finishedAtMs - state.startedAtMs)})`
        )}`,
      ];
    case "failed":
      return [
        `  ${theme.styled.fail(theme.symbols.fail)} ${displayName}: ${safeTerminalText(
          state.error.message
        )}`,
      ];
    case "cancelled":
      return [
        `  ${theme.styled.skip(theme.symbols.skip)} ${displayName}: cancelled: ${safeTerminalText(
          state.error.message
        )}`,
      ];
    case "skipped":
      return [
        `  ${theme.styled.skip(theme.symbols.skip)} ${displayName} ${theme.styled.duration(
          `(${state.message ?? state.reason})`
        )}`,
      ];
    case "planned":
      return [
        `  ${theme.styled.description(theme.symbols.pending)} ${displayName} ${theme.styled.description("waiting")}`,
      ];
  }
}

function reporterOutputFd(output: ReporterOutput): number | undefined {
  const stdoutFd = output === process.stdout ? process.stdout.fd : undefined;
  for (const fd of [output.fd, stdoutFd]) {
    if (fd !== undefined && Number.isInteger(fd) && fd >= 0) return fd;
  }
  return undefined;
}

function createInteractiveReporter<TResult>(
  options: PipelineReporterOptions,
  output: ReporterOutput
): PipelineReporterController<TResult> {
  const terminalIsTTY = options.terminal?.isTTY ?? output.isTTY === true;
  const theme = createReporterTheme({
    ...options,
    terminal: { isTTY: terminalIsTTY, ...options.terminal },
  });
  const progressBarWidth = Math.max(4, Math.floor(options.progressBarWidth ?? 20));
  // ~12.5 fps keeps braille spinners smooth without flooding the terminal.
  const refreshIntervalMs = Math.max(16, Math.floor(options.refreshIntervalMs ?? 80));
  const steps = new Map<string, StepState>();
  let plan: PipelinePlan | undefined;
  let result: PipelineRun<TResult> | undefined;
  let finalize: FinalizeState = { status: "idle" };
  let lastProgressRedrawAt = Number.NEGATIVE_INFINITY;
  let progressDirty = false;
  let disposed = false;
  let ticker: LiveTicker | undefined;
  let trailingFlush: ReturnType<typeof setTimeout> | undefined;
  let exitListener: (() => void) | undefined;

  const frameLines = (): string[] => {
    if (!plan) return [];
    const lines: string[] = [];
    if (options.logPlan !== false) {
      const header = result
        ? options.logSummary === false
          ? `Pipeline ${result.pipelineId}`
          : `Pipeline ${result.pipelineId}: done in ${formatDurationMs(result.finishedAtMs - result.startedAtMs)} (status=${result.status}, steps=${result.steps.length}, errors=${result.errors.length})`
        : `Pipeline ${plan.pipelineId} (${plan.steps.length} steps, dryRun=${plan.dryRun})`;
      lines.push(
        result?.status === "completed"
          ? theme.styled.complete(header)
          : result
            ? theme.styled.fail(header)
            : theme.styled.pipeline(header)
      );
    }
    for (const state of steps.values()) {
      lines.push(...renderStep(state, theme, SPINNER_TOKEN, progressBarWidth));
    }
    if (finalize.status === "running") {
      lines.push(`  ${theme.styled.start(SPINNER_TOKEN)} ${shimmerToken("finalize")}`);
    } else if (finalize.status === "completed") {
      lines.push(
        `  ${theme.styled.complete(theme.symbols.complete)} finalize ${theme.styled.duration(
          `(${formatDurationMs(finalize.durationMs)})`
        )}`
      );
    } else if (finalize.status === "failed") {
      lines.push(
        `  ${theme.styled.fail(theme.symbols.fail)} finalize: ${safeTerminalText(
          finalize.error.message
        )}`
      );
    }
    return lines;
  };

  const ensureTicker = (): LiveTicker => {
    if (!ticker) {
      ticker = createLiveTicker({
        color: theme.colorEnabled,
        columns: output.columns,
        getColumns: () => output.columns,
        fd: reporterOutputFd(output),
        refreshIntervalMs,
        unicode: theme.capabilities.unicode,
        write: (chunk) => {
          output.write(chunk);
        },
      });
    }
    return ticker;
  };

  const redraw = (): void => {
    if (disposed) return;
    const lines = frameLines();
    if (lines.length === 0) return;
    ensureTicker().setLines(lines);
  };

  const flushProgress = (): void => {
    if (trailingFlush !== undefined) {
      clearTimeout(trailingFlush);
      trailingFlush = undefined;
    }
    if (!progressDirty) return;
    progressDirty = false;
    lastProgressRedrawAt = Date.now();
    redraw();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (trailingFlush !== undefined) {
      clearTimeout(trailingFlush);
      trailingFlush = undefined;
    }
    ticker?.dispose();
    ticker = undefined;
    if (exitListener) process.off("exit", exitListener);
    exitListener = undefined;
  };

  const writeLog = (level: "error" | "log" | "warn", message?: unknown, ...args: unknown[]) => {
    const rendered = message === undefined && args.length === 0 ? "" : format(message, ...args);
    const safeRendered = safeTerminalLog(rendered);
    const prefix =
      level === "error"
        ? `${theme.styled.fail(theme.symbols.fail)} `
        : level === "warn"
          ? `${theme.styled.skip("!")} `
          : "";
    const text = `${prefix}${safeRendered}\n`;
    if (disposed) {
      output.write(text);
      return;
    }
    ensureTicker().writeLog(text);
    progressDirty = false;
    lastProgressRedrawAt = Date.now();
    redraw();
  };

  const log: PipelineLogger = {
    error: (message, ...args) => writeLog("error", message, ...args),
    log: (message, ...args) => writeLog("log", message, ...args),
    warn: (message, ...args) => writeLog("warn", message, ...args),
  };

  const hooks: PipelineHooks<TResult> = {
    onPipelineStart: (nextPlan) => {
      plan = nextPlan;
      for (const step of nextPlan.steps) {
        steps.set(step.id, { pipelineId: nextPlan.pipelineId, status: "planned", step });
      }
      if (output === process.stdout) {
        exitListener = dispose;
        process.once("exit", exitListener);
      }
      redraw();
    },
    onStepStatus: (event) => {
      const previous = steps.get(event.step.id);
      if (event.status === "running") {
        // Empty/non-visible progress only refreshes the frame; retain the last
        // visible progress snapshot while still publishing one running state.
        const progress =
          event.progress && hasVisibleStepProgress(event.progress)
            ? event.progress
            : previous?.status === "running"
              ? previous.progress
              : undefined;
        steps.set(event.step.id, {
          ...event,
          progress,
          startedAtMs: previous?.startedAtMs ?? Date.now(),
        });
        const now = Date.now();
        if (now - lastProgressRedrawAt >= refreshIntervalMs) {
          progressDirty = false;
          lastProgressRedrawAt = now;
          redraw();
        } else {
          progressDirty = true;
          trailingFlush ??= setTimeout(
            () => {
              trailingFlush = undefined;
              if (!disposed) flushProgress();
            },
            Math.max(0, refreshIntervalMs - (now - lastProgressRedrawAt))
          );
          trailingFlush.unref?.();
        }
        return;
      }
      if (event.status !== "planned") flushProgress();
      steps.set(event.step.id, event);
      redraw();
    },
    onFinalizeStart: () => {
      finalize = { status: "running" };
      redraw();
    },
    onFinalizeComplete: ({ durationMs }) => {
      finalize = { durationMs, status: "completed" };
      redraw();
    },
    onFinalizeError: ({ durationMs, error }) => {
      finalize = { durationMs, error, status: "failed" };
      redraw();
    },
    onPipelineComplete: (nextResult) => {
      result = nextResult;
      redraw();
      dispose();
    },
  };

  return { dispose, hooks, log, mode: "interactive" };
}

/** Create the plain or interactive reporter selected by the configured terminal mode. */
export function createPipelineReporter<TResult = unknown>(
  options: PipelineReporterOptions
): PipelineReporterController<TResult> {
  const output = options.output ?? process.stdout;
  const mode = resolveMode(output, options);
  if (mode === "interactive") {
    return createInteractiveReporter(options, output);
  }
  return {
    dispose: () => undefined,
    hooks: createRunReporter<TResult>(options),
    log: options.log,
    mode: "plain",
  };
}
