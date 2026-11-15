export type AttemptBatchAcknowledgement =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly runId: string };

export interface HostedAttemptDefinition {
  readonly launchId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly pipelineId: string;
  /** Host-selected executable revision; a structural trace fingerprint is not a code identity. */
  readonly deploymentId: string;
  readonly createdAtMs: number;
}

export interface HostedAttemptOwner {
  readonly launchId: string;
  readonly attemptId: string;
  /** Fresh per worker invocation, never copied from a redelivered job. */
  readonly workerId: string;
}

export class HostedAttemptConflict extends Error {
  constructor(
    readonly code: "ownership" | "replay" | "sequence" | "events",
    readonly expectedSequence?: number
  ) {
    super(`Hosted attempt ${code} conflict.`);
    this.name = "HostedAttemptConflict";
  }
}

/** Internal persistence contract; callers still need authenticated transport authority. */
export interface HostedAttemptStore {
  /** Atomically create a new launch and its only attempt. Never replace an existing launch/attempt. */
  createAttempt(definition: HostedAttemptDefinition): Promise<void>;
  /**
   * Grant execution once to the first matching worker. Even a repeated claim by
   * that worker returns false. An unconfirmed reply never grants permission to run.
   */
  claimAttempt(owner: HostedAttemptOwner, deploymentId: string, nowMs: number): Promise<boolean>;
  /**
   * Decode and hash the exact UTF-8 JSON envelope { attemptId, sequence, events }.
   * Atomically validate ownership, append events, and persist the digest and original ack.
   */
  acceptAttemptBatch(
    owner: HostedAttemptOwner,
    body: Uint8Array
  ): Promise<AttemptBatchAcknowledgement>;
  /** Persist cancellation intent and fence future claims. True acknowledges an open attempt, not exit. */
  requestAttemptCancellation(launchId: string, attemptId: string): Promise<boolean>;
  /** Live owned root runs in one deployment, independent of trusted launch recovery. */
  liveAttemptRunIds(deploymentId: string): Promise<readonly string[]>;
  /** Request cancellation only for a running owned root in this deployment. */
  requestAttemptRunCancellation(runId: string, deploymentId: string): Promise<boolean>;
  /** Revoke write authority only; this neither terminates execution nor invents a run outcome. */
  revokeAttempt(launchId: string, attemptId: string): Promise<void>;
}

export function assertAttemptId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error("Hosted attempt identities must contain 1 to 256 characters.");
}
