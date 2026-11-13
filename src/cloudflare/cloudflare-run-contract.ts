import type { ProjectTraceContext } from "../project/pipeline-project.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/** Alarm wall time is 15 minutes; abort earlier so the run records its own outcome. */
export const MAX_RUN_DURATION_MS = 840_000;
export const HOST_TERMINATED = "The Cloudflare run host stopped before the run finished.";

export interface CloudflareRunTraceContext extends ProjectTraceContext {
  readonly launchId: string;
}

export interface RunJob {
  readonly launchId: string;
  readonly commandId: string;
  readonly values: Record<string, unknown>;
  readonly maxRunDurationMs: number;
}

export interface StudioIngest {
  /** Studio's consent to execute; false when the launch is unknown or already closed. */
  admit(launchId: string): Promise<{ readonly admitted: boolean }>;
  /** `accepted` is false when Studio already closed the launch and refused the batch. */
  appendEvents(
    launchId: string,
    sequence: number,
    events: PipelineTraceEvent[]
  ): Promise<{ readonly accepted: boolean }>;
  reportFailure(launchId: string, message: string): Promise<void>;
}
