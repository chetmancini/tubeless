import type { ProjectTraceContext } from "../project/pipeline-project.js";

/** Alarm wall time is 15 minutes; abort earlier so the run records its own outcome. */
export const MAX_RUN_DURATION_MS = 840_000;
export const HOST_TERMINATED = "The Cloudflare run host stopped before the run finished.";

export interface CloudflareRunTraceContext extends ProjectTraceContext {
  readonly launchId: string;
}
