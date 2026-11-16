import type { PipelineStepProgress } from "./pipeline-types.js";

export function hasVisibleStepProgress(progress: PipelineStepProgress): boolean {
  return (
    Boolean(progress.message?.trim()) ||
    Boolean(progress.details?.length) ||
    (progress.total !== undefined && Number.isFinite(progress.total) && progress.total > 0) ||
    (Number.isFinite(progress.completed) && progress.completed > 0)
  );
}
