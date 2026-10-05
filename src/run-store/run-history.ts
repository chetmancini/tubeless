import type { StoredPipelineRun, StoredPipelineDefinition } from "./run-store.js";

interface RunHistoryItem {
  readonly runId: string;
  readonly pipelineId: string;
  readonly correlationId?: string;
  readonly parentRunId?: string;
  readonly startedAtMs: number;
  readonly status: StoredPipelineRun["status"];
  readonly eventCount: number;
}

export interface StoredRunSummary extends RunHistoryItem {
  dryRun: boolean;
  durationMs?: number;
  eventCount: number;
  subtreeEventCount: number;
  stepCount: number;
  rootRunId: string;
  descendantCount: number;
  subtreeIsRunning: boolean;
  activity: { count: number; names: string[]; message?: string };
}

export type StoredDefinitionSummary = Omit<
  StoredPipelineDefinition,
  "steps" | "targetIds" | "snapshot"
>;

export function summarizeRun(
  run: StoredPipelineRun,
  index: RunHistoryIndex<StoredPipelineRun>
): StoredRunSummary {
  const active = run.steps.filter((step) => step.status === "running");
  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    correlationId: run.correlationId,
    parentRunId: run.parentRunId,
    startedAtMs: run.startedAtMs,
    status: run.status,
    dryRun: run.dryRun,
    durationMs: run.durationMs,
    eventCount: run.eventCount,
    subtreeEventCount: index.subtreeEventCount(run.runId),
    stepCount: run.steps.length,
    rootRunId: index.rootRunId(run.runId)!,
    descendantCount: index.descendantCount(run.runId),
    subtreeIsRunning: index.subtreeIsRunning(run.runId),
    activity: {
      count: active.length,
      names: active.slice(0, 3).map((step) => step.name || step.id),
      message: active[0]?.progress?.message,
    },
  };
}

export function summarizeDefinition(definition: StoredPipelineDefinition): StoredDefinitionSummary {
  const { snapshot: _snapshot, steps: _steps, targetIds: _targets, ...summary } = definition;
  return summary;
}

const EMPTY_RUNS: readonly never[] = [];

export interface RunHistoryIndex<T extends RunHistoryItem> {
  readonly roots: readonly T[];
  ancestorsOf(runId: string | null | undefined): T[];
  childrenOf(runId: string): readonly T[];
  descendantCount(runId: string): number;
  matchingRootIds(query: string): ReadonlySet<string>;
  rootRunId(runId: string | null | undefined): string | null | undefined;
  runById(runId: string | null | undefined): T | undefined;
  subtreeIsRunning(runId: string): boolean;
  subtreeEventCount(runId: string): number;
}

/** Derived run hierarchy for one history revision. Rebuild when the snapshot is replaced. */
export function createRunHistoryIndex<T extends RunHistoryItem>(
  runs: readonly T[]
): RunHistoryIndex<T> {
  const runsById = new Map<string, T>();
  const childrenByParentId = new Map<string, T[]>();
  const parentIdByRunId = new Map<string, string | undefined>();
  for (const run of runs) {
    if (!runsById.has(run.runId)) runsById.set(run.runId, run);
    const parentRunId = run.parentRunId;
    if (!parentIdByRunId.has(run.runId)) parentIdByRunId.set(run.runId, parentRunId);
  }

  // Break one edge per malformed parent cycle so every recorded run remains
  // reachable from a history root.
  const resolvedParents = new Set<string>();
  for (const run of runs) {
    if (resolvedParents.has(run.runId)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let currentId: string | undefined = run.runId;
    while (currentId && runsById.has(currentId) && !resolvedParents.has(currentId)) {
      if (onPath.has(currentId)) {
        parentIdByRunId.set(currentId, undefined);
        break;
      }
      onPath.add(currentId);
      path.push(currentId);
      currentId = parentIdByRunId.get(currentId);
    }
    for (const id of path) resolvedParents.add(id);
  }

  for (const run of runs) {
    const parentRunId = parentIdByRunId.get(run.runId);
    if (!parentRunId) continue;
    const siblings = childrenByParentId.get(parentRunId);
    if (siblings) siblings.push(run);
    else childrenByParentId.set(parentRunId, [run]);
  }
  for (const siblings of childrenByParentId.values()) {
    siblings.sort((left, right) => right.startedAtMs - left.startedAtMs);
  }

  const roots: T[] = [];
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
  const subtreeEventsById = new Map<string, number>();
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
        let events = runsById.get(frame.id)?.eventCount ?? 0;
        for (const child of childrenByParentId.get(frame.id) ?? EMPTY_RUNS) {
          const childCount = descendantCountById.get(child.runId);
          if (childCount === undefined) continue;
          count += 1 + childCount;
          running = running || subtreeRunningById.get(child.runId) === true;
          events += subtreeEventsById.get(child.runId) ?? 0;
        }
        descendantCountById.set(frame.id, count);
        subtreeRunningById.set(frame.id, running);
        subtreeEventsById.set(frame.id, events);
        continue;
      }
      if (descendantCountById.has(frame.id) || visiting.has(frame.id)) continue;
      visiting.add(frame.id);
      stack.push({ exiting: true, id: frame.id });
      for (const child of childrenByParentId.get(frame.id) ?? EMPTY_RUNS) {
        if (!descendantCountById.has(child.runId) && !visiting.has(child.runId)) {
          stack.push({ exiting: false, id: child.runId });
        }
      }
    }
  }

  function runById(runId: string | null | undefined) {
    return runId == null ? undefined : runsById.get(runId);
  }
  function childrenOf(runId: string): readonly T[] {
    return childrenByParentId.get(runId) ?? EMPTY_RUNS;
  }
  function ancestorsOf(runId: string | null | undefined) {
    const ancestors: T[] = [];
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
        !run.runId.toLowerCase().includes(needle) &&
        !run.correlationId?.toLowerCase().includes(needle)
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
    subtreeEventCount(runId: string) {
      return subtreeEventsById.get(runId) ?? 0;
    },
  };
}
