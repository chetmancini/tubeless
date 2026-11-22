import { HOSTED_FAILURE_REASONS } from "./run-contract.js";

export const HOSTED_EXECUTIONS_PATH = "/api/executions/v1";

export function isLaunchIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}

export const HOSTED_EXECUTION_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const;

export type HostedExecutionState = (typeof HOSTED_EXECUTION_STATES)[number];

export const HOSTED_EXECUTION_REASONS = [
  ...HOSTED_FAILURE_REASONS,
  "start_unconfirmed",
  "history_unavailable",
  "runner_waiting",
  "runner_incompatible",
] as const;

export type HostedExecutionReason = (typeof HOSTED_EXECUTION_REASONS)[number];

/** Durable status of one hosted execution, independent of its runtime run ID. */
export interface HostedExecutionStatus {
  readonly executionId: string;
  readonly commandId: string;
  readonly state: HostedExecutionState;
  readonly cancellationRequested: boolean;
  readonly runId?: string;
  readonly target?: "cloudflare" | "local";
  readonly reason?: HostedExecutionReason;
}
