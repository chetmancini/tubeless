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

const ANSI = {
  clearDown: "\u001B[J",
  hideCursor: "\u001B[?25l",
  reset: "\u001B[0m",
  showCursor: "\u001B[?25h",
} as const;

const SPINNERS = {
  ascii: ["-", "\\", "|", "/"],
  unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

const ANSI_STYLE = /\u001B\[[0-9;]*m/g;
const ANSI_STYLE_PREFIX = /^\u001B\[[0-9;]*m/;
const COMBINING_MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}/u;
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

function characterWidth(character: string): number {
  if (COMBINING_MARK.test(character) || character === "\u200D") return 0;
  if (EMOJI.test(character)) return 2;
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
    ? 2
    : 1;
}

function visibleWidth(value: string): number {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

function fitLine(value: string, columns: number | undefined): string {
  if (!columns || columns <= 1) return value;
  const maxWidth = columns - 1;
  const plain = value.replace(ANSI_STYLE, "");
  if (visibleWidth(plain) <= maxWidth) return value;
  const targetWidth = Math.max(0, maxWidth - 1);
  let width = 0;
  let truncated = "";
  let index = 0;
  let hasStyle = false;
  while (index < value.length) {
    const style = value.slice(index).match(ANSI_STYLE_PREFIX)?.[0];
    if (style) {
      truncated += style;
      index += style.length;
      hasStyle = true;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    const nextWidth = width + characterWidth(character);
    if (nextWidth > targetWidth) break;
    truncated += character;
    width = nextWidth;
    index += character.length;
  }
  return `${truncated}${hasStyle ? ANSI.reset : ""}…`;
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
  const label = detail.label ? ` ${theme.styled.description(safeTerminalText(detail.label))}` : "";
  return `    ${symbol} ${safeTerminalText(detail.id)}${label}`;
}

function renderStep(
  state: StepState,
  theme: ReporterTheme,
  spinner: string,
  progressBarWidth: number,
  nowMs: number
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
          ? ` ${theme.styled.duration(formatDurationMs(Math.max(0, nowMs - state.startedAtMs)))}`
          : "";
      const lines = [`  ${theme.styled.start(spinner)} ${displayName}${progress}${elapsed}`];
      const details = state.progress?.details;
      if (details && details.length > 0) {
        for (const detail of details) {
          lines.push(renderProgressDetail(detail, theme, spinner));
        }
      }
      return lines;
    }
    case "complete":
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

function createInteractiveReporter<TResult>(
  options: PipelineReporterOptions,
  output: ReporterOutput
): PipelineReporterController<TResult> {
  const terminalIsTTY = options.terminal?.isTTY ?? output.isTTY === true;
  const theme = createReporterTheme({
    ...options,
    terminal: { isTTY: terminalIsTTY, ...options.terminal },
  });
  const spinnerFrames = theme.capabilities.unicode ? SPINNERS.unicode : SPINNERS.ascii;
  const progressBarWidth = Math.max(4, Math.floor(options.progressBarWidth ?? 20));
  // ~12.5 fps keeps braille spinners smooth without flooding the terminal.
  const refreshIntervalMs = Math.max(16, Math.floor(options.refreshIntervalMs ?? 80));
  const steps = new Map<string, StepState>();
  let plan: PipelinePlan | undefined;
  let result: PipelineRun<TResult> | undefined;
  let finalize: FinalizeState = { status: "idle" };
  let frameLineCount = 0;
  let lastProgressRedrawAt = Number.NEGATIVE_INFINITY;
  let progressDirty = false;
  let disposed = false;
  let cursorHidden = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let exitListener: (() => void) | undefined;

  /** Wall-clock spinner so progress redraws animate even if the interval is delayed. */
  const currentSpinner = (): string => {
    const frame = Math.floor(Date.now() / refreshIntervalMs) % spinnerFrames.length;
    return spinnerFrames[frame] ?? spinnerFrames[0]!;
  };

  const hasLiveWork = (): boolean =>
    finalize.status === "running" ||
    [...steps.values()].some((state) => state.status === "running");

  const clearFrame = (): void => {
    if (frameLineCount === 0) return;
    output.write(`\u001B[${frameLineCount}F${ANSI.clearDown}`);
    frameLineCount = 0;
  };

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
    const spinner = currentSpinner();
    const nowMs = Date.now();
    for (const state of steps.values()) {
      lines.push(...renderStep(state, theme, spinner, progressBarWidth, nowMs));
    }
    if (finalize.status === "running") {
      lines.push(`  ${theme.styled.start(spinner)} finalize`);
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
    return lines.map((line) => fitLine(line, output.columns));
  };

  const redraw = (): void => {
    if (disposed) return;
    clearFrame();
    const lines = frameLines();
    if (lines.length === 0) return;
    output.write(`${lines.join("\n")}\n`);
    frameLineCount = lines.length;
  };

  const flushProgress = (): void => {
    if (!progressDirty) return;
    progressDirty = false;
    lastProgressRedrawAt = Date.now();
    redraw();
  };

  const restoreCursor = (): void => {
    if (!cursorHidden) return;
    output.write(ANSI.showCursor);
    cursorHidden = false;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    restoreCursor();
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
    if (!disposed) clearFrame();
    output.write(`${prefix}${safeRendered}\n`);
    if (!disposed) redraw();
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
      output.write(ANSI.hideCursor);
      cursorHidden = true;
      if (output === process.stdout) {
        exitListener = restoreCursor;
        process.once("exit", exitListener);
      }
      redraw();
      // Keep a tick alive while work runs. Do not unref: long CPU-bound stretches
      // between awaits still need the interval scheduled; wall-clock frames handle
      // animation between ticks when progress redraws.
      timer = setInterval(() => {
        if (!hasLiveWork()) return;
        progressDirty = false;
        lastProgressRedrawAt = Date.now();
        redraw();
      }, refreshIntervalMs);
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
