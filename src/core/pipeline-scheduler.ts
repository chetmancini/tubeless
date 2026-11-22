import { stepEdges } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";

/**
 * Schedule the compiled DAG; execution owns step outcomes and the stop policy.
 * Edges must reference the same step objects as `orderedSteps`.
 */
export async function schedulePipelineSteps<TStep extends AnyStep>(input: {
  orderedSteps: readonly TStep[];
  maxConcurrency: number;
  executeOneStep(step: TStep): Promise<void>;
  shouldStop(): boolean;
}): Promise<readonly TStep[]> {
  const { orderedSteps, executeOneStep, maxConcurrency, shouldStop } = input;
  const indexByStep = new Map<AnyStep, number>(orderedSteps.map((step, index) => [step, index]));
  let nextReadyIndex = 0;
  const ready = new Set<TStep>();
  const running = new Map<TStep, Promise<void>>();
  const remainingPrerequisites = new Map<TStep, number>();
  const dependents = new Map<AnyStep, TStep[]>();
  for (const step of orderedSteps) {
    const edges = stepEdges(step);
    remainingPrerequisites.set(step, edges.length);
    if (edges.length === 0) ready.add(step);
    for (const prerequisite of edges) {
      const children = dependents.get(prerequisite) ?? [];
      children.push(step);
      dependents.set(prerequisite, children);
    }
  }

  const settleStep = (step: TStep): void => {
    running.delete(step);
    for (const dependent of dependents.get(step) ?? []) {
      const remaining = remainingPrerequisites.get(dependent)! - 1;
      remainingPrerequisites.set(dependent, remaining);
      if (remaining === 0) {
        ready.add(dependent);
        nextReadyIndex = Math.min(nextReadyIndex, indexByStep.get(dependent)!);
      }
    }
  };

  try {
    while (ready.size > 0 || running.size > 0) {
      // Keep our place instead of rescanning the completed prefix. A newly
      // ready step can rewind the cursor to preserve stable compiled order.
      while (ready.size > 0 && running.size < maxConcurrency && !shouldStop()) {
        const step = orderedSteps[nextReadyIndex++];
        if (!ready.delete(step)) continue;
        remainingPrerequisites.delete(step);
        const task = executeOneStep(step).then(() => settleStep(step));
        running.set(step, task);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
  } finally {
    // Even unexpected execution errors must not let in-flight work escape the run.
    await Promise.allSettled(running.values());
  }
  return [...remainingPrerequisites.keys()];
}
