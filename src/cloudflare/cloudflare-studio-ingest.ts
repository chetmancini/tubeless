import type { HostedFailureReason } from "../hosting/run-contract.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/** Private Studio RPC. A recovery generation fences mutations from older run hosts. */
export interface CloudflareStudioIngest {
  admit(launchId: string, generation?: number): Promise<{ readonly admitted: boolean }>;
  appendEvents(
    launchId: string,
    sequence: number,
    events: PipelineTraceEvent[],
    generation?: number
  ): Promise<{ readonly accepted: boolean }>;
  reportFailure(
    launchId: string,
    message: string,
    reason?: HostedFailureReason,
    generation?: number
  ): Promise<void>;
}
