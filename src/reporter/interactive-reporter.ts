import { format } from "node:util";
import type {
  PipelineError,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineStepProgress,
  PipelineStepStatus,
} from "../core/pipeline.js";
import { hasVisibleStepProgress } from "../core/progress.js";
import { PIPELINE_FINALIZE_STEP_ID } from "../core/pipeline-step-metadata.js";
import { STEP_LOG_SCOPE, type StepScopedLogger } from "../core/step-log-scope.js";
import { elapsedToken, shimmerToken, SPINNER_TOKEN } from "./live-ticker-frame.js";
import { createLiveTicker, type LiveTicker } from "./live-ticker.js";
import {
  createReporterTheme,
  createRunReporter,
  formatDurationMs,
  outputSourceSuffix,
  type ReporterTheme,
  type RunReporterConfig,
} from "./reporter.js";
import { safeTerminalLog, safeTerminalText } from "./terminal-text.js";

/** Failed-step lines retained when they were only visible in the log pane. */
const PANE_ONLY_LOG_LIMIT = 50;
/** Characters kept per log line in pane and failed-output buffers. */
const MAX_RETAINED_LOG_LINE = 2048;

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
    (detail.label ? safeTerminalText(detail.label) : "") + outputSourceSuffix(detail.outputSource);
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

/** Read-only view of sibling step rows, used to explain waits and skips. */
interface StepLookup {
  label(stepId: string): string;
  status(stepId: string): StepState["status"] | undefined;
}

const WAITING_NAME_LIMIT = 3;

function skipDetail(state: Extract<StepState, { status: "skipped" }>, lookup: StepLookup): string {
  if (state.dependencyId === undefined) return safeTerminalText(state.message ?? state.reason);
  const dependency = lookup.label(state.dependencyId);
  const outcome = lookup.status(state.dependencyId);
  return outcome === "failed" || outcome === "cancelled" || outcome === "skipped"
    ? `not run: ${dependency} ${outcome}`
    : `${state.reason}: ${dependency}`;
}

function waitingDetail(step: PipelinePlanStep, lookup: StepLookup): string {
  const pending = [...new Set([...step.dependencies, ...step.optionalDependencies])].filter(
    (id) => {
      const status = lookup.status(id);
      return status === "planned" || status === "running";
    }
  );
  if (pending.length === 0) return "waiting";
  const shown = pending.slice(0, WAITING_NAME_LIMIT).map((id) => lookup.label(id));
  const more = pending.length - shown.length;
  return `waiting on ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
}

function renderStep(
  state: StepState,
  theme: ReporterTheme,
  spinner: string,
  progressBarWidth: number,
  lookup: StepLookup
): string[] {
  const { step } = state;
  const displayName =
    safeTerminalText(step.name ?? step.id) +
    (state.status === "planned" ? "" : outputSourceSuffix(state.outputSource));
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
        `  ${theme.styled.fail(theme.symbols.fail)} ${displayName} ${theme.styled.duration(
          `(${formatDurationMs(state.finishedAtMs - state.startedAtMs)})`
        )}: ${safeTerminalText(state.error.message)}`,
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
          `(${skipDetail(state, lookup)})`
        )}`,
      ];
    case "planned":
      return [
        `  ${theme.styled.description(theme.symbols.pending)} ${displayName} ${theme.styled.description(
          waitingDetail(step, lookup)
        )}`,
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
  const paneOnlyLogs = new Map<string, { dropped: number; lines: string[] }>();
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
  let pipelineStartedAtMs = 0;

  const separator = theme.unicodeEnabled ? " · " : " - ";
  const lookup: StepLookup = {
    label: (stepId) => stepLabel(stepId),
    status: (stepId) => steps.get(stepId)?.status,
  };

  const liveHeader = (current: PipelinePlan): string => {
    let done = 0;
    for (const state of steps.values()) {
      if (state.status !== "planned" && state.status !== "running") done += 1;
    }
    return [
      `Pipeline ${safeTerminalText(current.pipelineId)}`,
      `${done}/${steps.size} done`,
      elapsedToken(pipelineStartedAtMs),
      ...(current.dryRun ? ["dry run"] : []),
    ].join(separator);
  };

  const summaryHeader = (run: PipelineRun<TResult>): string => {
    // Steps outside the selection are not part of what the user asked to run.
    const counted = run.steps.filter(
      (step) => !(step.status === "skipped" && step.reason === "filtered")
    );
    const outcomes = (["failed", "cancelled", "skipped"] as const).flatMap((status) => {
      const count = counted.filter((step) => step.status === status).length;
      return count > 0 ? [`${count} ${status}`] : [];
    });
    const total = `${counted.length} ${counted.length === 1 ? "step" : "steps"}`;
    return `Pipeline ${safeTerminalText(run.pipelineId)} ${run.status} in ${formatDurationMs(
      run.finishedAtMs - run.startedAtMs
    )}${separator}${[total, ...outcomes].join(", ")}`;
  };

  const frameLines = (): string[] => {
    if (!plan) return [];
    const lines: string[] = [];
    if (options.logPlan !== false) {
      const header = result
        ? options.logSummary === false
          ? `Pipeline ${safeTerminalText(result.pipelineId)}`
          : summaryHeader(result)
        : liveHeader(plan);
      lines.push(
        result?.status === "completed"
          ? theme.styled.complete(header)
          : result
            ? theme.styled.fail(header)
            : theme.styled.pipeline(header)
      );
    }
    for (const state of steps.values()) {
      lines.push(...renderStep(state, theme, SPINNER_TOKEN, progressBarWidth, lookup));
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

  const stepLabel = (stepId: string): string => {
    const step = steps.get(stepId)?.step;
    if (step) return safeTerminalText(step.name ?? step.id);
    return stepId === PIPELINE_FINALIZE_STEP_ID ? "finalize" : safeTerminalText(stepId);
  };

  const retainPaneOnlyLines = (stepId: string, lines: readonly string[]): void => {
    const retained = paneOnlyLogs.get(stepId) ?? { dropped: 0, lines: [] };
    retained.lines.push(...lines);
    const excess = Math.max(0, retained.lines.length - PANE_ONLY_LOG_LIMIT);
    retained.lines.splice(0, excess);
    retained.dropped += excess;
    paneOnlyLogs.set(stepId, retained);
  };

  const writeLog = (
    level: "error" | "log" | "warn",
    stepId: string | undefined,
    message?: unknown,
    ...args: unknown[]
  ) => {
    const rendered = message === undefined && args.length === 0 ? "" : format(message, ...args);
    const safeRendered = safeTerminalLog(rendered);
    const prefix =
      level === "error"
        ? `${theme.styled.fail(theme.symbols.fail)} `
        : level === "warn"
          ? `${theme.styled.skip("!")} `
          : "";
    const bodyLines = `${prefix}${safeRendered}`.split("\n");
    const source =
      stepId === undefined ? "" : `${theme.styled.description(`[${stepLabel(stepId)}]`)} `;
    const lines = bodyLines.map((line) => `${source}${line}`);
    const text = `${lines.join("\n")}\n`;
    if (disposed) {
      output.write(text);
      return;
    }
    // Retained copies are bounded; scrollback keeps the full line.
    const bounded = (line: string): string => line.slice(0, MAX_RETAINED_LOG_LINE);
    // Retain a bounded tail for the pane, including when the terminal is resized.
    recentLogs.push(...lines.slice(-8).map(bounded));
    recentLogs.splice(0, Math.max(0, recentLogs.length - 8));
    if (logPaneVisible()) {
      // The pane disappears with the final frame; keep what never reached scrollback.
      if (stepId !== undefined) retainPaneOnlyLines(stepId, bodyLines.map(bounded));
    } else {
      ensureTicker().writeLog(text);
    }
    progressDirty = false;
    lastProgressRedrawAt = Date.now();
    redraw();
  };

  const stepLog = (stepId: string | undefined): PipelineLogger => {
    const logger: StepScopedLogger = {
      error: (message, ...args) => writeLog("error", stepId, message, ...args),
      log: (message, ...args) => writeLog("log", stepId, message, ...args),
      warn: (message, ...args) => writeLog("warn", stepId, message, ...args),
    };
    // Child runs inherit a bound logger; their lines belong to this run's step.
    logger[STEP_LOG_SCOPE] = stepId === undefined ? stepLog : () => logger;
    return logger;
  };
  const log = stepLog(undefined);

  /** Show failed steps' output that was only visible in the log pane. */
  const writePaneOnlyFailureOutput = (run: PipelineRun<TResult>): void => {
    const failedIds = run.steps.filter((step) => step.status === "failed").map((step) => step.id);
    if (finalize.status === "failed") failedIds.push(PIPELINE_FINALIZE_STEP_ID);
    const ellipsis = theme.unicodeEnabled ? "…" : "...";
    for (const stepId of failedIds) {
      const retained = paneOnlyLogs.get(stepId);
      if (!retained) continue;
      const lines = [
        `${theme.styled.fail(theme.symbols.fail)} ${stepLabel(stepId)} output:`,
        ...(retained.dropped > 0
          ? [`    ${theme.styled.description(`${ellipsis} ${retained.dropped} earlier lines`)}`]
          : []),
        ...retained.lines.map((line) => `    ${line}`),
      ];
      output.write(`${lines.join("\n")}\n`);
    }
    paneOnlyLogs.clear();
  };

  const hooks: PipelineHooks<TResult> = {
    onPipelineStart: (nextPlan) => {
      plan = nextPlan;
      pipelineStartedAtMs = Date.now();
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
      writePaneOnlyFailureOutput(nextResult);
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
