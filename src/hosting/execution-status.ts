import { HOSTED_FAILURE_REASONS } from "./run-contract.js";
import {
  wireBoolean,
  wireEnum,
  wireObject,
  wireOptional,
  wireString,
  type WireSchema,
} from "../tracing/wire-schema.js";

export const HOSTED_EXECUTIONS_PATH = "/api/executions/v1";

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
  "journal_outcome_unknown",
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

const text = wireString({ allowEmpty: true });
export const hostedExecutionStatusSchema: WireSchema<HostedExecutionStatus> = wireObject({
  executionId: text,
  commandId: text,
  state: wireEnum(HOSTED_EXECUTION_STATES),
  cancellationRequested: wireBoolean(),
  runId: wireOptional(text),
  target: wireOptional(wireEnum(["cloudflare", "local"])),
  reason: wireOptional(wireEnum(HOSTED_EXECUTION_REASONS)),
});

export function executionIsActive(status: HostedExecutionStatus): boolean {
  return status.state === "queued" || status.state === "running";
}
