import type { StoredRunSummary } from "../../run-store/run-history.js";
import type { StudioChildStep } from "./schema.js";

export function compareChildRuns(left: StoredRunSummary, right: StoredRunSummary): number {
  return (
    (left.origin?.iteration ?? 0) - (right.origin?.iteration ?? 0) ||
    left.startedAtMs - right.startedAtMs
  );
}

export function groupChildRunsByStep(children: readonly StoredRunSummary[]) {
  const groups = new Map<string | undefined, StoredRunSummary[]>();
  for (const child of children) {
    const key = child.origin?.stepId;
    const group = groups.get(key);
    if (group) group.push(child);
    else groups.set(key, [child]);
  }
  return groups;
}

export function indexChildRunPages(
  children: readonly StoredRunSummary[],
  childSteps: readonly StudioChildStep[] = []
) {
  const groups = groupChildRunsByStep(children);
  const totals = new Map(childSteps.map(({ stepId, count }) => [stepId, count]));
  return (stepId: string) => {
    const runs = groups.get(stepId) ?? [];
    return { runs, total: Math.max(totals.get(stepId) ?? 0, runs.length) };
  };
}
