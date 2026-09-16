import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";
import type { PipelineRunStoreSnapshot, StoredPipelineRun } from "../run-store/run-store.js";

export interface StudioSnapshot extends PipelineRunStoreSnapshot {
  liveRunIds?: readonly string[];
}

export interface StudioRunDetail {
  run: StoredPipelineRun;
}

export interface StudioState {
  canCancel: boolean;
  canClearHistory: boolean;
  cancelling: boolean;
  clearing: boolean;
  commands: PipelineRunStudioCommand[];
  detail: StudioRunDetail | null;
  detailFingerprint: string | null;
  launching: boolean;
  loading: boolean;
  planning: boolean;
  planVersion: number;
  query: string;
  runIndex: StudioRunIndex;
  selectedRunId: string | null;
  snapshot: StudioSnapshot | null;
  view: string;
}

const EMPTY_STUDIO_RUNS: readonly StoredPipelineRun[] = [];

export interface StudioRunIndex {
  readonly roots: readonly StoredPipelineRun[];
  ancestorsOf(runId: string | null | undefined): StoredPipelineRun[];
  childrenOf(runId: string): readonly StoredPipelineRun[];
  descendantCount(runId: string): number;
  matchingRootIds(query: string): ReadonlySet<string>;
  rootRunId(runId: string | null | undefined): string | null | undefined;
  runById(runId: string | null | undefined): StoredPipelineRun | undefined;
  subtreeIsRunning(runId: string): boolean;
}

/** Initial mutable state for one Studio browser client. */
export function createStudioState(): StudioState {
  return {
    snapshot: null,
    runIndex: createStudioRunIndex([]),
    detail: null,
    detailFingerprint: null,
    commands: [],
    view: "runs",
    selectedRunId: null,
    query: "",
    loading: false,
    launching: false,
    planning: false,
    clearing: false,
    cancelling: false,
    canCancel: false,
    canClearHistory: false,
    planVersion: 0,
  };
}

/** Derived run hierarchy for one studio snapshot. Rebuild when the snapshot is replaced. */
export function createStudioRunIndex(runs: readonly StoredPipelineRun[]): StudioRunIndex {
  const runsById = new Map<string, StoredPipelineRun>();
  const childrenByParentId = new Map<string, StoredPipelineRun[]>();
  const parentIdByRunId = new Map<string, string | undefined>();
  for (const run of runs) {
    if (!runsById.has(run.runId)) runsById.set(run.runId, run);
    const parentRunId = run.parentRunId;
    if (!parentIdByRunId.has(run.runId)) parentIdByRunId.set(run.runId, parentRunId);
    if (!parentRunId) continue;
    const siblings = childrenByParentId.get(parentRunId);
    if (siblings) siblings.push(run);
    else childrenByParentId.set(parentRunId, [run]);
  }
  for (const siblings of childrenByParentId.values()) {
    siblings.sort((left, right) => right.startedAtMs - left.startedAtMs);
  }

  const roots: StoredPipelineRun[] = [];
  const rootIds = new Set<string>();
  for (const run of runs) {
    const parentRunId = parentIdByRunId.get(run.runId);
    if (parentRunId && runsById.has(parentRunId)) continue;
    roots.push(run);
    rootIds.add(run.runId);
  }

  const rootIdByRunId = new Map<string, string | undefined>();
  for (const run of runs) {
    if (rootIdByRunId.has(run.runId)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let currentId: string | undefined = run.runId;
    let resolved: string | undefined;
    while (currentId) {
      if (rootIdByRunId.has(currentId)) {
        resolved = rootIdByRunId.get(currentId);
        break;
      }
      if (rootIds.has(currentId)) {
        resolved = currentId;
        break;
      }
      if (onPath.has(currentId)) {
        resolved = undefined;
        break;
      }
      onPath.add(currentId);
      path.push(currentId);
      const parentRunId = parentIdByRunId.get(currentId);
      if (!parentRunId || !runsById.has(parentRunId)) {
        resolved = currentId;
        break;
      }
      currentId = parentRunId;
    }
    if (resolved !== undefined) rootIdByRunId.set(resolved, resolved);
    for (const id of path) rootIdByRunId.set(id, resolved);
  }

  const descendantCountById = new Map<string, number>();
  const subtreeRunningById = new Map<string, boolean>();
  for (const run of runs) {
    if (descendantCountById.has(run.runId)) continue;
    const stack: { exiting: boolean; id: string }[] = [{ exiting: false, id: run.runId }];
    const visiting = new Set<string>();
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      if (frame.exiting) {
        visiting.delete(frame.id);
        let count = 0;
        let running = runsById.get(frame.id)?.status === "running";
        for (const child of childrenByParentId.get(frame.id) ?? EMPTY_STUDIO_RUNS) {
          const childCount = descendantCountById.get(child.runId);
          if (childCount === undefined) continue;
          count += 1 + childCount;
          running = running || subtreeRunningById.get(child.runId) === true;
        }
        descendantCountById.set(frame.id, count);
        subtreeRunningById.set(frame.id, running);
        continue;
      }
      if (descendantCountById.has(frame.id) || visiting.has(frame.id)) continue;
      visiting.add(frame.id);
      stack.push({ exiting: true, id: frame.id });
      for (const child of childrenByParentId.get(frame.id) ?? EMPTY_STUDIO_RUNS) {
        if (!descendantCountById.has(child.runId) && !visiting.has(child.runId)) {
          stack.push({ exiting: false, id: child.runId });
        }
      }
    }
  }

  function runById(runId: string | null | undefined) {
    return runId == null ? undefined : runsById.get(runId);
  }
  function childrenOf(runId: string): readonly StoredPipelineRun[] {
    return childrenByParentId.get(runId) ?? EMPTY_STUDIO_RUNS;
  }
  function ancestorsOf(runId: string | null | undefined) {
    const ancestors: StoredPipelineRun[] = [];
    const seen = new Set<string>();
    let current = runById(runId);
    while (current) {
      const parentRunId = parentIdByRunId.get(current.runId);
      if (!parentRunId || seen.has(parentRunId)) break;
      seen.add(parentRunId);
      const parent = runsById.get(parentRunId);
      if (!parent) break;
      ancestors.unshift(parent);
      current = parent;
    }
    return ancestors;
  }
  function matchingRootIds(query: string): ReadonlySet<string> {
    const needle = query.toLowerCase();
    const matched = new Set<string>();
    if (!needle) {
      for (const root of roots) matched.add(root.runId);
      return matched;
    }
    for (const run of runs) {
      if (
        !run.pipelineId.toLowerCase().includes(needle) &&
        !run.runId.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const rootId = rootIdByRunId.get(run.runId);
      if (rootId) matched.add(rootId);
    }
    return matched;
  }

  return {
    roots,
    ancestorsOf,
    childrenOf,
    descendantCount(runId: string) {
      return descendantCountById.get(runId) ?? 0;
    },
    matchingRootIds,
    rootRunId(runId: string | null | undefined) {
      return runId == null ? runId : (rootIdByRunId.get(runId) ?? runId);
    },
    runById,
    subtreeIsRunning(runId: string) {
      return subtreeRunningById.get(runId) === true;
    },
  };
}
