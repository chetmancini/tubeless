import type { PipelineStepOutputSource } from "../tracing/tracing-constants.js";
import { safeTerminalText } from "./terminal-text.js";

export function formatDurationMs(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) {
    const seconds = Math.round(ms / 100) / 10;
    if (seconds < 60) {
      return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
    }
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

export function outputSourceSuffix(source?: PipelineStepOutputSource): string {
  return source === "override"
    ? " (overridden)"
    : source === "cache"
      ? " (cached)"
      : source === "supplied"
        ? " (supplied)"
        : "";
}

export function stepDisplayName(
  step: { id: string; name?: string },
  source?: PipelineStepOutputSource
): string {
  return safeTerminalText(step.name ?? step.id) + outputSourceSuffix(source);
}
