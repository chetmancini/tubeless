import type { StoredRunSummary } from "../../run-store/run-history.js";

export function compareChildRuns(left: StoredRunSummary, right: StoredRunSummary): number {
  return (
    (left.origin?.iteration ?? 0) - (right.origin?.iteration ?? 0) ||
    left.startedAtMs - right.startedAtMs
  );
}
