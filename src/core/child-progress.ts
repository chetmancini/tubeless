import type {
  PipelineHooks,
  PipelinePlan,
  PipelineStepProgress,
  PipelineStepProgressDetail,
  PipelineStepStatus,
} from "./pipeline-types.js";
import { hasVisibleStepProgress } from "./progress.js";
import {
  toMappedChildStepProgress,
  type MappedChildProgressSnapshot,
  type ToMappedChildStepProgressOptions,
} from "./mapped-child-progress.js";

const LIVE_FAN_OUT_GROUP_LIMIT = 32;

type ReportProgress = (progress: PipelineStepProgress) => void;

/** Retain one child's step states without forwarding its lifecycle to parent hooks. */
function createChildProgress(plan: PipelinePlan) {
  const rows = new Map<string, PipelineStepProgressDetail>();
  const progress = new Map<string, PipelineStepProgress>();
  const terminalSteps = new Set<string>();
  for (const step of plan.steps) {
    if (step.selected) rows.set(step.id, { id: step.id, name: step.name, status: "pending" });
  }
  return {
    total: plan.ok ? rows.size : 0,
    get completed() {
      return terminalSteps.size;
    },
    complete(): number {
      const previous = terminalSteps.size;
      if (plan.ok) for (const id of rows.keys()) terminalSteps.add(id);
      return terminalSteps.size - previous;
    },
    update(event: PipelineStepStatus) {
      const name = event.step.name ?? event.step.id;
      // Filtered steps are announced by single children, but never counted or
      // included in the retained tree or mapped activity labels.
      if (event.status === "skipped" && event.reason === "filtered") {
        return { message: `${name}: skipped: filtered`, label: undefined, terminalDelta: 0 };
      }
      if (!rows.has(event.step.id) || event.status === "planned") return;
      let message: string;
      let label: string;
      let errorLabel: string | undefined;
      switch (event.status) {
        case "running":
          if (event.progress) {
            if (!hasVisibleStepProgress(event.progress)) return;
            progress.set(event.step.id, event.progress);
            message = event.progress.message ?? `${event.progress.completed} completed`;
            label = `${name}:${event.progress.message ?? (event.progress.total !== undefined ? `${event.progress.completed}/${event.progress.total}` : `${event.progress.completed}`)}`;
          } else {
            message = "started";
            label = name;
          }
          break;
        case "completed":
          message = "complete";
          label = `${name}:complete`;
          break;
        case "skipped":
          message = `skipped: ${event.reason}`;
          label = `${name}:skipped:${event.reason}`;
          errorLabel = event.message ?? event.reason;
          break;
        case "cancelled":
        case "failed":
          message = `${event.status}: ${event.error.message}`;
          label = `${name}:${event.status}`;
          errorLabel = event.error.message;
          break;
      }
      const previous = terminalSteps.size;
      if (event.status !== "running") terminalSteps.add(event.step.id);
      const latest = progress.get(event.step.id);
      const row: PipelineStepProgressDetail = {
        id: event.step.id,
        name: event.step.name,
        status: event.status,
      };
      if (latest) {
        row.completed = latest.completed;
        row.total = latest.total;
        row.label = latest.message;
      }
      if (errorLabel !== undefined) row.label = errorLabel;
      rows.set(event.step.id, row);
      return {
        message: `${name}: ${message}`,
        label,
        terminalDelta: terminalSteps.size - previous,
      };
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

/** Project canonical child statuses into the opaque parent's progress. */
export function createSingleChildProgress(
  plan: PipelinePlan,
  report: ReportProgress
): PipelineHooks {
  const child = createChildProgress(plan);
  return {
    onStepStatus(event) {
      const update = child.update(event);
      if (!update) return;
      report({
        completed: child.completed,
        total: Math.max(1, child.total),
        message: `${plan.pipelineId}/${update.message}`,
        details: child.details(),
      });
    },
  };
}

/** Own fan-out counts, activity labels and bounded detail rendering. */
export function createMappedChildProgress(
  keys: readonly string[],
  concurrency: number,
  options: ToMappedChildStepProgressOptions | undefined,
  report: ReportProgress
) {
  const active = new Map<string, string>();
  const failedKeys = new Set<string>();
  const itemIndexes = new Map(keys.map((key, index) => [key, index]));
  const itemRows = new Map<string, PipelineStepProgressDetail>(
    keys.map((id) => [id, { id, status: "pending" }])
  );
  const children = new Map<string, ReturnType<typeof createChildProgress>>();
  let finishedItems = 0;
  let failedItems = 0;
  let stepsPerItem = 0;
  let plannedChildSteps = 0;
  let plannedItems = 0;
  let terminalChildSteps = 0;

  const publish = (spotlight?: string, final = false): void => {
    const snapshot: MappedChildProgressSnapshot = {
      active,
      concurrency,
      failedItems,
      finishedItems,
      itemCount: keys.length,
      plannedChildSteps,
      plannedItems,
      stepsPerItem,
      terminalChildSteps,
      spotlight,
    };
    // Materialize only the visible window. Active and failed sets avoid a
    // scan or sort of the entire fan-out on every child status event.
    const limit = Math.max(0, Math.floor(options?.detailLimit ?? LIVE_FAN_OUT_GROUP_LIMIT)) || 0;
    let visibleKeys: readonly string[];
    if (final && options?.detailLimit === undefined) {
      visibleKeys = keys;
    } else {
      const visible = new Set<string>();
      for (const candidates of [active.keys(), failedKeys.keys(), keys.values()]) {
        for (const key of candidates) {
          if (visible.size >= limit) break;
          visible.add(key);
        }
      }
      visibleKeys = [...visible].sort(
        (left, right) => itemIndexes.get(left)! - itemIndexes.get(right)!
      );
    }
    const details = visibleKeys.flatMap((key) => [
      { ...itemRows.get(key)! },
      ...(children.get(key)?.details() ?? []).map((detail) => ({
        ...detail,
        depth: (detail.depth ?? 0) + 1,
      })),
    ]);
    if (visibleKeys.length < keys.length) {
      details.push({ id: `+${keys.length - visibleKeys.length} more`, status: "pending" });
    }
    report({ ...toMappedChildStepProgress(snapshot, options), details });
  };

  return {
    publish,
    start(key: string): void {
      active.set(key, "starting");
      itemRows.set(key, { id: key, status: "running" });
      publish();
    },
    plan(key: string, plan: PipelinePlan): PipelineHooks {
      const child = createChildProgress(plan);
      children.set(key, child);
      if (plan.ok) {
        plannedChildSteps += child.total;
        plannedItems += 1;
        stepsPerItem = Math.max(stepsPerItem, child.total);
      }
      return {
        onStepStatus(event) {
          const update = child.update(event);
          if (!update || update.label === undefined) return;
          terminalChildSteps += update.terminalDelta;
          active.set(key, update.label);
          publish();
        },
      };
    },
    childCompleted(key: string): void {
      // Public child implementations may return success without emitting all
      // statuses. Reconcile their selected steps before mapping the result.
      terminalChildSteps += children.get(key)?.complete() ?? 0;
    },
    complete(key: string): void {
      active.delete(key);
      itemRows.set(key, { id: key, status: "completed" });
      finishedItems += 1;
      publish(`${key}: completed`);
    },
    fail(key: string, error: Error, cancelled: boolean): void {
      active.delete(key);
      itemRows.set(key, {
        id: key,
        status: cancelled ? "cancelled" : "failed",
        label: error.message,
      });
      failedKeys.add(key);
      failedItems += 1;
      publish(`${key}: failed`);
    },
    finish(): void {
      if (options?.detailLimit === undefined && keys.length > LIVE_FAN_OUT_GROUP_LIMIT) {
        publish(undefined, true);
      }
    },
  };
}
