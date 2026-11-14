import type { ProjectTraceContext } from "../project/pipeline-project.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/** One admitted launch's application-exporter context, independent of its execution target. */
export interface HostedRunTraceContext extends ProjectTraceContext {
  readonly launchId: string;
}

export interface RunJob {
  readonly launchId: string;
  readonly commandId: string;
  readonly values: Record<string, unknown>;
  /** Target-approved cooperative budget, starting after admission is confirmed. */
  readonly maxRunDurationMs: number;
}

/** Trusted host/collector capability; this is not an authenticated network protocol. */
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
