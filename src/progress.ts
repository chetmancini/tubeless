import type { PipelineStepProgress } from "./pipeline-types.js";

/** True when progress contains work information rather than an empty snapshot. */
export function hasVisibleStepProgress(progress: PipelineStepProgress): boolean {
  return (
    Boolean(progress.message?.trim()) ||
    Boolean(progress.details?.length) ||
    (progress.total !== undefined && Number.isFinite(progress.total) && progress.total > 0) ||
    (Number.isFinite(progress.completed) && progress.completed > 0)
  );
}
