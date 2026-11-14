import type { PipelineRunEventReader } from "../run-store/run-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

export type BatchAcknowledgement =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly runId?: string };

/**
 * Trusted collector persistence. Every mutation commits atomically, including
 * appended history and launch state. Validation failures roll back; a transport
 * error can leave the caller unsure whether a transaction committed.
 * Admission is consent, not a lease; the executor owns duplicate execution prevention.
 */
export interface HostedLaunchStore extends PipelineRunEventReader {
  /** Create a new starting launch; reject duplicate ids without modifying history. */
  create(launchId: string, commandId: string, nowMs: number): Promise<void>;
  /** Grant repeatable consent for open launches; return false for unknown or terminal launches. */
  admit(launchId: string): Promise<boolean>;
  /**
   * Atomically append history, bind the first root start, update terminal state and
   * advance sequence. Ack committed sequences with the persisted root run id,
   * including replays after completion. Reject gaps for open launches; reject new terminal-launch
   * batches without advancing the committed sequence. Rejected retries stay
   * rejected. This trusted port does not verify digests.
   */
  acceptBatch(
    launchId: string,
    sequence: number,
    events: readonly PipelineTraceEvent[]
  ): Promise<BatchAcknowledgement>;
  /**
   * Close an open launch and synthesize completions for its open run subtree,
   * children first. Ignore unknown/terminal launches. The caller owns evidence
   * of host failure; this operation does not terminate execution.
   */
  fail(launchId: string, message: string, nowMs: number): Promise<void>;
  /** Atomically fail only if admission has not been granted. */
  failUnadmitted(launchId: string, message: string, nowMs: number): Promise<void>;
  /** Bound root ids for running launches, in creation order. */
  liveRunIds(): Promise<readonly string[]>;
  /** Resolve only a running launch owned by the supplied root run. */
  launchIdForRun(runId: string): Promise<string | undefined>;
  /** Open launches whose root-start time (or creation time before start) is <= cutoff. */
  stale(cutoffMs: number): Promise<readonly string[]>;
  /** Earliest open root-start/creation timestamp plus delay, or undefined when idle. */
  nextReconcileAt(delayMs: number): Promise<number | undefined>;
}
