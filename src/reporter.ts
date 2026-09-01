import type { PipelineHooks, PipelineLogger } from "./pipeline.js";
import { hasVisibleStepProgress } from "./progress.js";

export type ReporterColorMode = "always" | "auto" | "never";
export type ReporterSymbolMode = "ascii" | "auto" | "emoji" | "unicode";

export interface ReporterTerminalCapabilities {
  color: boolean;
  isTTY: boolean;
  unicode: boolean;
}

export interface RunReporterConfig {
  /** Defaults to auto: color only when the output supports it. */
  color?: ReporterColorMode;
  /** Defaults to auto: Unicode in capable terminals, ASCII elsewhere. */
  symbols?: ReporterSymbolMode;
  /** Override detected capabilities, primarily for custom streams and tests. */
  terminal?: Partial<ReporterTerminalCapabilities>;
  /** Log the pipeline start summary. Defaults to true. */
  logPlan?: boolean;
  /** Log the final pipeline summary. Defaults to true. */
  logSummary?: boolean;
}

export interface RunReporterOptions extends RunReporterConfig {
  log: PipelineLogger;
}

export interface ReporterSymbols {
  complete: string;
  fail: string;
  pending: string;
  skip: string;
  start: string;
}

const SYMBOLS = {
  ascii: { complete: "ok", fail: "fail", pending: ".", skip: "-", start: "->" },
  // Distinct from pending (○): skipped work uses a yellow dash, not a green check.
  unicode: { complete: "✓", fail: "✗", pending: "○", skip: "–", start: "→" },
  emoji: { complete: "✅", fail: "❌", pending: "▫️", skip: "⏭️", start: "⏳" },
} satisfies Record<Exclude<ReporterSymbolMode, "auto">, ReporterSymbols>;

const ANSI = {
  boldCyan: "\u001B[1;36m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  reset: "\u001B[0m",
  yellow: "\u001B[33m",
} as const;

function detectTerminalCapabilities(
  overrides: Partial<ReporterTerminalCapabilities> = {}
): ReporterTerminalCapabilities {
  const isTTY = overrides.isTTY ?? process.stdout.isTTY === true;
  const termIsDumb = process.env.TERM === "dumb";
  const forceColor = process.env.FORCE_COLOR;
  const autoColor =
    forceColor !== undefined
      ? forceColor !== "0"
      : process.env.NO_COLOR === undefined && isTTY && !termIsDumb;
  return {
    isTTY,
    color: overrides.color ?? autoColor,
    unicode: overrides.unicode ?? (isTTY && !termIsDumb),
  };
}

function resolveColorEnabled(
  mode: ReporterColorMode,
  capabilities: ReporterTerminalCapabilities
): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return capabilities.color;
}

function resolveSymbols(
  mode: ReporterSymbolMode,
  capabilities: ReporterTerminalCapabilities
): ReporterSymbols {
  return SYMBOLS[mode === "auto" ? (capabilities.unicode ? "unicode" : "ascii") : mode];
}

function paint(enabled: boolean, code: string, value: string): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

export function formatDurationMs(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

export interface ReporterTheme {
  capabilities: ReporterTerminalCapabilities;
  colorEnabled: boolean;
  styled: {
    complete(value: string): string;
    description(value: string): string;
    duration(value: string): string;
    fail(value: string): string;
    pipeline(value: string): string;
    skip(value: string): string;
    start(value: string): string;
  };
  symbols: ReporterSymbols;
}

export function createReporterTheme(config: RunReporterConfig = {}): ReporterTheme {
  const capabilities = detectTerminalCapabilities(config.terminal);
  const colorEnabled = resolveColorEnabled(config.color ?? "auto", capabilities);
  const symbols = resolveSymbols(config.symbols ?? "auto", capabilities);
  return {
    capabilities,
    colorEnabled,
    symbols,
    styled: {
      complete: (value) => paint(colorEnabled, ANSI.green, value),
      description: (value) => paint(colorEnabled, ANSI.dim, value),
      duration: (value) => paint(colorEnabled, ANSI.dim, value),
      fail: (value) => paint(colorEnabled, ANSI.red, value),
      pipeline: (value) => paint(colorEnabled, ANSI.boldCyan, value),
      skip: (value) => paint(colorEnabled, ANSI.yellow, value),
      start: (value) => paint(colorEnabled, ANSI.cyan, value),
    },
  };
}

/** Create concise, append-only lifecycle logging for a pipeline run. */
export function createRunReporter<TResult = unknown>(
  options: RunReporterOptions
): PipelineHooks<TResult> {
  const { log } = options;
  const logPlan = options.logPlan !== false;
  const logSummary = options.logSummary !== false;
  const { styled, symbols } = createReporterTheme(options);
  // Throttle progress lines so concurrent mapped children stay readable.
  const lastProgressLogAt = new Map<string, number>();
  const lastProgressMessage = new Map<string, string>();
  const progressLogIntervalMs = 750;
  const displayName = (step: { id: string; name?: string }): string => step.name ?? step.id;
  const clearProgress = (stepId: string): void => {
    lastProgressLogAt.delete(stepId);
    lastProgressMessage.delete(stepId);
  };

  return {
    onPipelineStart: (plan) => {
      if (!logPlan) return;
      log.log(
        styled.pipeline(
          `Pipeline ${plan.pipelineId}: starting (${plan.steps.length} steps, dryRun=${plan.dryRun})`
        )
      );
    },
    onStepStart: ({ step }) => {
      const description = step.description ? ` - ${styled.description(step.description)}` : "";
      log.log(`  ${styled.start(symbols.start)} ${displayName(step)}${description}`);
    },
    onStepProgress: ({ progress, step }) => {
      // Ignore empty/non-visible progress snapshots (no message, total, or work count).
      if (!hasVisibleStepProgress(progress)) return;

      const total =
        progress.total !== undefined && Number.isFinite(progress.total)
          ? String(progress.total)
          : "?";
      const message = progress.message ? ` ${progress.message}` : "";
      const line = `${progress.completed}/${total}${message}`;
      const now = Date.now();
      const previousAt = lastProgressLogAt.get(step.id) ?? Number.NEGATIVE_INFINITY;
      const previousLine = lastProgressMessage.get(step.id);
      const isCompletion =
        progress.total !== undefined &&
        Number.isFinite(progress.total) &&
        progress.completed >= progress.total;
      if (!isCompletion && line === previousLine && now - previousAt < progressLogIntervalMs) {
        return;
      }
      if (!isCompletion && now - previousAt < progressLogIntervalMs && previousLine !== undefined) {
        return;
      }
      lastProgressLogAt.set(step.id, now);
      lastProgressMessage.set(step.id, line);
      log.log(`  ${styled.description("…")} ${displayName(step)} ${styled.description(line)}`);
    },
    onStepComplete: (event) => {
      clearProgress(event.id);
      const durationMs = event.finishedAtMs - event.startedAtMs;
      log.log(
        `  ${styled.complete(symbols.complete)} ${displayName(event)} ${styled.duration(`(${formatDurationMs(durationMs)})`)}`
      );
    },
    onStepSkip: (event) => {
      clearProgress(event.id);
      const detail = event.dependencyId
        ? `${event.reason}: ${event.dependencyId}`
        : (event.message ?? event.reason);
      log.log(
        `  ${styled.skip(symbols.skip)} ${displayName(event.step)} ${styled.duration(`(${detail})`)}`
      );
    },
    onStepCancel: (event) => {
      clearProgress(event.id);
      log.warn(
        `  ${styled.skip(symbols.skip)} ${displayName(event.step)}: cancelled: ${event.error.message}`
      );
    },
    onStepFail: (event) => {
      clearProgress(event.id);
      log.error(
        `  ${styled.fail(symbols.fail)} ${displayName(event.step)}: ${event.error.message}`
      );
    },
    onFinalizeStart: () => {
      log.log(`  ${styled.start(symbols.start)} finalize`);
    },
    onFinalizeComplete: ({ durationMs }) => {
      log.log(
        `  ${styled.complete(symbols.complete)} finalize ${styled.duration(`(${formatDurationMs(durationMs)})`)}`
      );
    },
    onFinalizeError: ({ error }) => {
      log.error(`  ${styled.fail(symbols.fail)} finalize: ${error.message}`);
    },
    onPipelineComplete: (result) => {
      if (!logSummary) return;
      const durationMs = result.finishedAtMs - result.startedAtMs;
      const message = `Pipeline ${result.pipelineId}: done in ${formatDurationMs(durationMs)} (status=${result.status}, steps=${result.steps.length}, errors=${result.errors.length})`;
      if (result.status === "completed") {
        log.log(styled.complete(message));
      } else {
        log.error(styled.fail(message));
      }
    },
  };
}
