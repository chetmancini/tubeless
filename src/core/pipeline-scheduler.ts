import { compiledStepGraph, stepEdges, type CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";

/** Schedule the compiled DAG; execution owns step outcomes and the stop policy. */
export async function schedulePipelineSteps<TOptions extends object>(input: {
  orderedSteps: readonly AnyStep<TOptions>[];
  stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>;
  maxConcurrency: number;
  executeOneStep(step: AnyStep<TOptions>): Promise<void>;
  shouldStop(): boolean;
}): Promise<readonly AnyStep<TOptions>[]> {
  const { orderedSteps, executeOneStep, maxConcurrency, shouldStop } = input;
  const pending = new Set(orderedSteps);
  const ready = new Set<AnyStep<TOptions>>();
  const running = new Map<AnyStep<TOptions>, Promise<void>>();
  const terminal = new Set<AnyStep<TOptions>>();
  const prerequisites = new Map(
    orderedSteps.map((step) => [step, stepEdges(step, compiledStepGraph(input, step))])
  );
  const dependents = new Map<AnyStep<TOptions>, AnyStep<TOptions>[]>();
  for (const [step, edges] of prerequisites) {
    if (edges.length === 0) ready.add(step);
    for (const prerequisite of edges) {
      const children = dependents.get(prerequisite) ?? [];
      children.push(step);
      dependents.set(prerequisite, children);
    }
  }

  try {
    while (ready.size > 0 || running.size > 0) {
      // Scan the stable compiled order, including newly unlocked steps before
      // later ready steps. With one slot this preserves the original loop order.
      for (const step of orderedSteps) {
        if (running.size >= maxConcurrency || shouldStop()) break;
        if (!ready.delete(step)) continue;
        pending.delete(step);
        const task = executeOneStep(step).then(() => {
          running.delete(step);
          terminal.add(step);
          for (const dependent of dependents.get(step) ?? []) {
            if (prerequisites.get(dependent)!.every((edge) => terminal.has(edge))) {
              ready.add(dependent);
            }
          }
        });
        running.set(step, task);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
  } finally {
    // Even unexpected execution errors must not let in-flight work escape the run.
    await Promise.allSettled(running.values());
  }
  return [...pending];
}
