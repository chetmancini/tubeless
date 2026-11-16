import type { PipelineLogger } from "./pipeline-types.js";

/**
 * Internal capability a log sink exposes to learn which step emitted a line.
 * Lifecycle binds each step's logger through it; child runs inherit the bound
 * sink, so a sink that returns itself keeps attribution to its own run's step.
 */
export const STEP_LOG_SCOPE: unique symbol = Symbol("tubeless.stepLogScope");

export type StepScopedLogger = PipelineLogger & {
  [STEP_LOG_SCOPE]?: (stepId: string) => PipelineLogger;
};

export function scopeStepLogger(log: PipelineLogger, stepId: string | undefined): PipelineLogger {
  if (stepId === undefined) return log;
  // SAFETY: the optional symbol is only defined by sinks that implement the scope contract.
  return (log as StepScopedLogger)[STEP_LOG_SCOPE]?.(stepId) ?? log;
}
