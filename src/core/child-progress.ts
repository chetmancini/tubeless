import type {
  PipelinePlan,
  PipelineStepProgress,
  PipelineStepProgressDetail,
  PipelineStepStatus,
} from "./pipeline-types.js";
import { hasVisibleStepProgress } from "./progress.js";

/** Retain one child's step states without forwarding its lifecycle to parent hooks. */
export function createChildProgress(plan: PipelinePlan) {
  const rows = new Map<string, PipelineStepProgressDetail>();
  const progress = new Map<string, PipelineStepProgress>();
  for (const step of plan.steps) {
    if (step.selected) rows.set(step.id, { id: step.id, name: step.name, status: "pending" });
  }
  return {
    update(event: PipelineStepStatus): void {
      if (!rows.has(event.step.id)) return;
      if (event.status === "running" && event.progress && hasVisibleStepProgress(event.progress)) {
        progress.set(event.step.id, event.progress);
      }
      const latest = progress.get(event.step.id);
      const row: PipelineStepProgressDetail = {
        id: event.step.id,
        name: event.step.name,
        status: event.status === "planned" ? "pending" : event.status,
      };
      if (latest) {
        row.completed = latest.completed;
        row.total = latest.total;
        row.label = latest.message;
      }
      if (event.status === "failed" || event.status === "cancelled")
        row.label = event.error.message;
      if (event.status === "skipped") row.label = event.message ?? event.reason;
      rows.set(event.step.id, row);
    },
    details(): PipelineStepProgressDetail[] {
      return [...rows.values()].flatMap((row) => [
        { ...row },
        ...(progress.get(row.id)?.details ?? []).map((detail) => ({
          ...detail,
          depth: (detail.depth ?? 0) + 1,
          status:
            (detail.status ?? "running") === "running" && row.status !== "running"
              ? row.status
              : detail.status,
        })),
      ]);
    },
  };
}
