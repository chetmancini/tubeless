import type { PipelineHooks, PipelineLogger } from "../core/pipeline.js";
import { hasVisibleStepProgress } from "../core/progress.js";
import { formatDurationMs, stepDisplayName } from "./reporter-format.js";
import { safeTerminalText } from "./terminal-text.js";

/** Policy for ANSI color in terminal reporter output. */
export type ReporterColorMode = "always" | "auto" | "never";
/** Symbol set used for step lifecycle markers in reporter output. */
export type ReporterSymbolMode = "ascii" | "auto" | "emoji" | "unicode";

/** Detected or caller-overridden terminal rendering capabilities. */
export interface ReporterTerminalCapabilities {
  color: boolean;
  isTTY: boolean;
  unicode: boolean;
}

/** Presentation settings shared by plain and interactive pipeline reporters. */
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
  const isTTY = overrides.isTTY ?? process.stdout.isTTY;
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
  unicodeEnabled: boolean;
}

export function createReporterTheme(config: RunReporterConfig = {}): ReporterTheme {
  const capabilities = detectTerminalCapabilities(config.terminal);
  const colorEnabled = resolveColorEnabled(config.color ?? "auto", capabilities);
  const symbolMode = config.symbols ?? "auto";
  const symbols = resolveSymbols(symbolMode, capabilities);
  const unicodeEnabled = symbolMode === "auto" ? capabilities.unicode : symbolMode !== "ascii";
  return {
    capabilities,
    colorEnabled,
    symbols,
    unicodeEnabled,
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
  const { styled, symbols, unicodeEnabled } = createReporterTheme(options);
  const lastProgressLogAt = new Map<string, number>();
  const progressLogIntervalMs = 750;
  const ellipsis = unicodeEnabled ? "…" : "...";
  return {
    onPipelineStart: (plan) => {
      if (!logPlan) return;
      log.log(
        styled.pipeline(
          `Pipeline ${safeTerminalText(plan.pipelineId)}: starting (${plan.steps.length} steps, dryRun=${plan.dryRun})`
        )
      );
    },
    onStepStart: ({ step, outputSource }) => {
      const description = step.description
        ? ` - ${styled.description(safeTerminalText(step.description))}`
        : "";
      log.log(
        `  ${styled.start(symbols.start)} ${stepDisplayName(step, outputSource)}${description}`
      );
    },
    onStepProgress: ({ progress, step }) => {
      if (!hasVisibleStepProgress(progress)) return;

      const total =
        progress.total !== undefined && Number.isFinite(progress.total)
          ? String(progress.total)
          : "?";
      const message = progress.message ? ` ${safeTerminalText(progress.message)}` : "";
      const line = `${progress.completed}/${total}${message}`;
      const now = Date.now();
      const previousAt = lastProgressLogAt.get(step.id) ?? Number.NEGATIVE_INFINITY;
      const isCompletion =
        progress.total !== undefined &&
        Number.isFinite(progress.total) &&
        progress.completed >= progress.total;
      if (!isCompletion && now - previousAt < progressLogIntervalMs) return;
      lastProgressLogAt.set(step.id, now);
      log.log(
        `  ${styled.description(ellipsis)} ${stepDisplayName(step)} ${styled.description(line)}`
      );
    },
    onStepComplete: (event) => {
      lastProgressLogAt.delete(event.id);
      const durationMs = event.finishedAtMs - event.startedAtMs;
      log.log(
        `  ${styled.complete(symbols.complete)} ${stepDisplayName(event, event.outputSource)} ${styled.duration(`(${formatDurationMs(durationMs)})`)}`
      );
    },
    onStepSkip: (event) => {
      lastProgressLogAt.delete(event.id);
      const detail = safeTerminalText(
        event.dependencyId
          ? `${event.reason}: ${event.dependencyId}`
          : (event.message ?? event.reason)
      );
      log.log(
        `  ${styled.skip(symbols.skip)} ${stepDisplayName(event, event.outputSource)} ${styled.duration(`(${detail})`)}`
      );
    },
    onStepCancel: (event) => {
      lastProgressLogAt.delete(event.id);
      log.warn(
        `  ${styled.skip(symbols.skip)} ${stepDisplayName(event, event.outputSource)}: cancelled: ${safeTerminalText(event.error.message)}`
      );
    },
    onStepFail: (event) => {
      lastProgressLogAt.delete(event.id);
      log.error(
        `  ${styled.fail(symbols.fail)} ${stepDisplayName(event, event.outputSource)}: ${safeTerminalText(event.error.message)}`
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
      log.error(`  ${styled.fail(symbols.fail)} finalize: ${safeTerminalText(error.message)}`);
    },
    onPipelineComplete: (result) => {
      if (!logSummary) return;
      const durationMs = result.finishedAtMs - result.startedAtMs;
      const message = `Pipeline ${safeTerminalText(result.pipelineId)}: done in ${formatDurationMs(durationMs)} (status=${result.status}, steps=${result.steps.length}, errors=${result.errors.length})`;
      if (result.status === "completed") {
        log.log(styled.complete(message));
      } else {
        log.error(styled.fail(message));
      }
    },
  };
}
