import { format } from "node:util";
import type {
  PipelineError,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelineRun,
  PipelineStepProgress,
  PipelineStepStatus,
} from "../core/pipeline.js";
import { hasVisibleStepProgress } from "../core/progress.js";
import { elapsedToken, shimmerToken, SPINNER_TOKEN } from "./live-ticker-frame.js";
import { createLiveTicker, type LiveTicker } from "./live-ticker.js";
import {
  createReporterTheme,
  createRunReporter,
  formatDurationMs,
  type ReporterTheme,
  type RunReporterConfig,
} from "./reporter.js";
import { safeTerminalLog, safeTerminalText } from "./terminal-text.js";

/** Rendering mode selected for pipeline lifecycle reporting. */
export type PipelineReporterMode = "auto" | "interactive" | "plain";
export type ResolvedPipelineReporterMode = Exclude<PipelineReporterMode, "auto">;

/** Writable terminal-like destination used by the interactive reporter. */
export interface ReporterOutput {
  readonly columns?: number;
  readonly rows?: number;
  /**
   * File descriptor for live frames. When set, spinner, elapsed time, and shimmer
   * paint on a worker thread so they keep moving during CPU-bound steps. Defaults
   * to stdout's fd when `output` is `process.stdout`.
   */
  readonly fd?: number;
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

/** Rendering and output settings for automatic, plain, or interactive reporting. */
export interface PipelineReporterConfig extends RunReporterConfig {
  /** Auto selects the interactive renderer only for a capable, non-CI TTY. */
  mode?: PipelineReporterMode;
  /** Terminal stream used by the interactive renderer. Defaults to stdout. */
  output?: ReporterOutput;
  /** Spinner redraw cadence. Defaults to 80ms. */
  refreshIntervalMs?: number;
  /** Filled/empty character width for determinate progress. Defaults to 20. */
  progressBarWidth?: number;
  /** Show recent logs beside progress in TTYs at least 120 columns by 8 rows. Defaults to auto. */
  logPane?: "auto" | "off";
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
  details?: PipelineStepProgress["details"];
};

type FinalizeState =
  | { status: "idle" }
  | { status: "running" }
  | { durationMs: number; status: "completed" }
  | { durationMs: number; error: PipelineError; status: "failed" };

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
  spinner: string,
  progressBarWidth: number,
  parentStatus: PipelineStepStatus["status"]
): string {
  const status =
    (detail.status ?? "running") === "running" && parentStatus !== "running"
      ? parentStatus
      : (detail.status ?? "running");
  const symbol =
    status === "completed"
      ? theme.styled.complete(theme.symbols.complete)
      : status === "failed"
        ? theme.styled.fail(theme.symbols.fail)
        : status === "skipped" || status === "cancelled"
          ? theme.styled.skip(theme.symbols.skip)
          : status === "pending"
            ? theme.styled.description(theme.symbols.pending)
            : theme.styled.start(spinner);
  const id = safeTerminalText(detail.name ?? detail.id);
  const label =
    (detail.label ? safeTerminalText(detail.label) : "") +
    (detail.outputSource === "override" ? " (overridden)" : "");
  const labelText = status === "cancelled" ? `cancelled${label ? `: ${label}` : ""}` : label;
  const running = status === "running";
  const body = labelText ? `${id} ${labelText}` : id;
  const paintedBody =
    running && theme.colorEnabled
      ? shimmerToken(body)
      : `${id}${labelText ? ` ${theme.styled.description(labelText)}` : ""}`;
  const depth = Math.max(0, Math.min(32, Math.floor(safeNumber(detail.depth ?? 0))));
  const progress =
    detail.completed === undefined
      ? ""
      : ` ${renderProgress(
          { completed: detail.completed, total: detail.total },
          progressBarWidth,
          theme.unicodeEnabled
        )}`;
  return `${"  ".repeat(depth + 2)}${symbol} ${paintedBody}${progress}`;
}

function renderStep(
  state: StepState,
  theme: ReporterTheme,
  spinner: string,
  progressBarWidth: number
): string[] {
  const { step } = state;
  const displayName =
    safeTerminalText(step.name ?? step.id) +
    (state.status !== "planned" && state.outputSource === "override" ? " (overridden)" : "");
  switch (state.status) {
    case "running": {
      const progress =
        state.progress && hasVisibleStepProgress(state.progress)
          ? ` ${renderProgress(state.progress, progressBarWidth, theme.unicodeEnabled)}`
          : "";
      const elapsed =
        state.startedAtMs !== undefined
          ? ` ${theme.styled.duration(elapsedToken(state.startedAtMs))}`
          : "";
      const lines = [
        `  ${theme.styled.start(spinner)} ${shimmerToken(displayName)}${progress}${elapsed}`,
      ];
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
          `(${safeTerminalText(state.message ?? state.reason)})`
        )}`,
      ];
    case "planned":
      return [
        `  ${theme.styled.description(theme.symbols.pending)} ${displayName} ${theme.styled.description("waiting")}`,
      ];
  }
}

function reporterOutputFd(output: ReporterOutput): number | undefined {
  const fd = output.fd ?? (output === process.stdout ? process.stdout.fd : undefined);
  return fd !== undefined && Number.isInteger(fd) && fd >= 0 ? fd : undefined;
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
  const recentLogs: string[] = [];
  let plan: PipelinePlan | undefined;
  let result: PipelineRun<TResult> | undefined;
  let finalize: FinalizeState = { status: "idle" };
  let lastProgressRedrawAt = Number.NEGATIVE_INFINITY;
  let progressDirty = false;
  let disposed = false;
  let ticker: LiveTicker | undefined;
  let trailingFlush: ReturnType<typeof setTimeout> | undefined;
  let exitListener: (() => void) | undefined;
  let resizeOutput: NodeJS.WriteStream | undefined;

  const frameLines = (): string[] => {
    if (!plan) return [];
    const lines: string[] = [];
    if (options.logPlan !== false) {
      const header = result
        ? options.logSummary === false
          ? `Pipeline ${safeTerminalText(result.pipelineId)}`
          : `Pipeline ${safeTerminalText(result.pipelineId)}: done in ${formatDurationMs(result.finishedAtMs - result.startedAtMs)} (status=${result.status}, steps=${result.steps.length}, errors=${result.errors.length})`
        : `Pipeline ${safeTerminalText(plan.pipelineId)} (${plan.steps.length} steps, dryRun=${plan.dryRun})`;
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
      for (const detail of state.details ?? []) {
        lines.push(
          renderProgressDetail(detail, theme, SPINNER_TOKEN, progressBarWidth, state.status)
        );
      }
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
        unicode: theme.unicodeEnabled,
        write: (chunk) => {
          output.write(chunk);
        },
      });
    }
    return ticker;
  };

  const logPaneVisible = (): boolean =>
    plan !== undefined &&
    !result &&
    options.logPane !== "off" &&
    (output.columns ?? 0) >= 120 &&
    (output.rows ?? 0) >= 8;

  const redraw = (): void => {
    if (disposed) return;
    const lines = frameLines();
    if (lines.length === 0 && !logPaneVisible()) {
      ticker?.setLines([]);
      return;
    }
    const rows = output.rows;
    const logPane = logPaneVisible()
      ? recentLogs.length > 0
        ? recentLogs.slice(-Math.min(8, (rows ?? 0) - 3))
        : [theme.unicodeEnabled ? "Waiting for logs…" : "Waiting for logs..."]
      : undefined;
    if (rows === undefined || rows < 2 || lines.length < rows) {
      ensureTicker().setLines(lines, logPane);
      return;
    }
    if (result) {
      // A finished tree can scroll normally; never try to erase beyond the viewport.
      ensureTicker().setLines([]);
      ensureTicker().writeLog(`${lines.join("\n")}\n`);
      return;
    }
    const ellipsis = theme.unicodeEnabled ? "…" : "...";
    if (rows < 5) {
      ensureTicker().setLines(
        [lines[0]!, `  ${ellipsis} ${lines.length - 1} rows omitted`].slice(0, rows - 1)
      );
      return;
    }
    const available = rows - 4;
    let focus = 0;
    for (const [index, line] of lines.entries()) {
      if (line.includes(SPINNER_TOKEN)) focus = index;
    }
    const start = Math.max(
      1,
      Math.min(lines.length - available, focus - Math.floor(available / 2))
    );
    const end = start + available;
    const visible = [lines[0]!];
    if (start > 1) visible.push(`  ${ellipsis} ${start - 1} rows above`);
    visible.push(...lines.slice(start, end));
    if (end < lines.length) visible.push(`  ${ellipsis} ${lines.length - end} rows below`);
    ensureTicker().setLines(visible, logPane);
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
    resizeOutput?.off("resize", redraw);
    resizeOutput = undefined;
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
    // Retain a bounded tail for the pane, including when the terminal is resized.
    recentLogs.push(
      ...`${prefix}${safeRendered}`
        .split("\n")
        .slice(-8)
        .map((line) => line.slice(0, 2048))
    );
    recentLogs.splice(0, Math.max(0, recentLogs.length - 8));
    if (!logPaneVisible()) ensureTicker().writeLog(text);
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
      if (output === process.stdout || output === process.stderr) {
        exitListener = dispose;
        process.once("exit", exitListener);
        resizeOutput = output === process.stdout ? process.stdout : process.stderr;
        resizeOutput.on("resize", redraw);
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
          details: progress?.details,
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
      steps.set(event.step.id, { ...event, details: previous?.details });
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
