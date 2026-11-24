import type { StoredRunSummary } from "../../run-store/run-history.js";
import { STUDIO_CHILD_PAGE_SIZE } from "../shared/limits.js";
import type { StudioChildStep } from "../shared/schema.js";
import { compareChildRuns, groupChildRunsByStep } from "../shared/children.js";

/**
 * One page of direct children, capped per parent step in the order the graph draws:
 * iteration, then start time. Page 0 is what run detail ships; later pages continue
 * each step so the nested run list can open runs the canvas only counts.
 */
export function pageDirectChildren(
  children: readonly StoredRunSummary[],
  stepIds: readonly string[],
  page: number,
  pageSize = STUDIO_CHILD_PAGE_SIZE
): { children: StoredRunSummary[]; childCount: number; childSteps: StudioChildStep[] } {
  const groups = groupChildRunsByStep(children);
  const known = new Set(stepIds);
  const keys = [
    ...stepIds.filter((id) => groups.has(id)),
    ...[...groups.keys()].filter((key) => key !== undefined && !known.has(key)).sort(),
    ...(groups.has(undefined) ? [undefined] : []),
  ];
  const start = page * pageSize;
  const end = start + pageSize;
  const window: StoredRunSummary[] = [];
  const childSteps: StudioChildStep[] = [];
  for (const key of keys) {
    const group = groups.get(key)!;
    group.sort(compareChildRuns);
    childSteps.push(
      key === undefined ? { count: group.length } : { stepId: key, count: group.length }
    );
    if (start < group.length) window.push(...group.slice(start, end));
  }
  return { children: window, childCount: children.length, childSteps };
}
