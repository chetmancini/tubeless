import { snapshotPipelineMetadata } from "../tracing/graph-metadata.js";
import type { CompiledStepCache } from "./pipeline-cache.js";
import type { AnyStep } from "./pipeline-steps.js";
import {
  STEP_CACHE,
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  STEP_REMOTE,
} from "./pipeline-step-metadata.js";

export interface CompiledStepGraph<TOptions extends object = object> {
  readonly dependsOn: readonly AnyStep<TOptions>[];
  readonly optionalDependsOn: readonly AnyStep<TOptions>[];
  readonly skipAfterFailureOf: readonly AnyStep<TOptions>[];
}

export type CompiledStep<TOptions extends object = object> = Omit<
  AnyStep<TOptions>,
  "dependsOn" | "optionalDependsOn" | "skipAfterFailureOf"
>;

export function liveStepGraph<TOptions extends object>(
  step: AnyStep<TOptions>
): CompiledStepGraph<TOptions> {
  return {
    dependsOn: step.dependsOn ?? [],
    optionalDependsOn: step.optionalDependsOn ?? [],
    skipAfterFailureOf: step.skipAfterFailureOf ?? [],
  };
}

function compileStep<TOptions extends object>(
  step: AnyStep<TOptions>,
  cache: CompiledStepCache<TOptions> | undefined
): CompiledStep<TOptions> {
  const nestedPipeline = step[STEP_NESTED_PIPELINE];
  const remote = step[STEP_REMOTE];
  const optionsSchema = step[STEP_OPTIONS_SCHEMA];
  const name = step.name;
  const description = step.description;
  const metadata = snapshotPipelineMetadata(step.metadata);
  const dryRun = step.dryRun;
  const outputSchema = step.outputSchema;
  const skip = step.skip;
  const compiled = {
    id: step.id,
    run: step.run.bind(step),
  };
  if (nestedPipeline !== undefined) {
    Object.assign(compiled, {
      [STEP_NESTED_PIPELINE]: Object.freeze({
        ...nestedPipeline,
        stepIds: Object.freeze([...nestedPipeline.stepIds]),
      }),
    });
  }
  if (remote !== undefined)
    Object.assign(compiled, { [STEP_REMOTE]: Object.freeze({ ...remote }) });
  if (optionsSchema !== undefined)
    Object.assign(compiled, { [STEP_OPTIONS_SCHEMA]: optionsSchema });
  if (metadata !== undefined) Object.assign(compiled, { metadata });
  if (name !== undefined) Object.assign(compiled, { name });
  if (description !== undefined) Object.assign(compiled, { description });
  if (dryRun !== undefined) {
    Object.assign(compiled, {
      dryRun: typeof dryRun === "function" ? dryRun.bind(step) : dryRun,
    });
  }
  if (cache) Object.assign(compiled, { [STEP_CACHE]: cache });
  if (outputSchema !== undefined) Object.assign(compiled, { outputSchema });
  if (skip !== undefined) Object.assign(compiled, { skip: skip.bind(step) });
  return Object.freeze(compiled);
}

function snapshotCompiledStepGraph<TOptions extends object>(
  step: AnyStep<TOptions>,
  compiledByAuthorStep: ReadonlyMap<AnyStep<TOptions>, CompiledStep<TOptions>>
): CompiledStepGraph<TOptions> {
  const compileDependencies = (
    dependencies: readonly AnyStep<TOptions>[] | undefined
  ): readonly CompiledStep<TOptions>[] =>
    Object.freeze(
      (dependencies ?? []).map((dependency) => {
        const compiled = compiledByAuthorStep.get(dependency);
        if (compiled === undefined) {
          throw new Error(`Compiled pipeline graph is missing dependency ${dependency.id}`);
        }
        return compiled;
      })
    );
  return Object.freeze({
    dependsOn: compileDependencies(step.dependsOn),
    optionalDependsOn: compileDependencies(step.optionalDependsOn),
    skipAfterFailureOf: compileDependencies(step.skipAfterFailureOf),
  });
}

export function compiledStepGraph<TOptions extends object>(
  compiled: Pick<{ stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph> }, "stepGraph">,
  step: AnyStep<TOptions>
): CompiledStepGraph<TOptions> {
  const graph = compiled.stepGraph.get(step);
  if (graph === undefined) {
    throw new Error(`Compiled pipeline graph is missing step ${step.id}`);
  }
  // SAFETY: compile stores each descriptor as the map key.
  return graph as CompiledStepGraph<TOptions>;
}

/** Returns every distinct edge into a step, regardless of dependency policy. */
export function stepEdges<TOptions extends object>(
  step: AnyStep<TOptions>,
  graph: CompiledStepGraph<TOptions> = liveStepGraph(step)
): readonly AnyStep<TOptions>[] {
  return [
    ...new Set([...graph.dependsOn, ...graph.optionalDependsOn, ...graph.skipAfterFailureOf]),
  ];
}

/** Required data and failure-gate closure for dependency-aware targets. */
export function targetClosure<TOptions extends object>(
  targets: readonly AnyStep<TOptions>[]
): Set<AnyStep<TOptions>> {
  const selected = new Set<AnyStep<TOptions>>();
  const include = (step: AnyStep<TOptions>): void => {
    if (selected.has(step)) return;
    selected.add(step);
    for (const prerequisite of [...(step.dependsOn ?? []), ...(step.skipAfterFailureOf ?? [])]) {
      include(prerequisite);
    }
  };
  for (const target of targets) include(target);
  return selected;
}

/** Orders steps so every dependency runs before its dependents. */
export function topologicalSort<TOptions extends object>(
  steps: readonly AnyStep<TOptions>[]
): readonly AnyStep<TOptions>[] | null {
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  const remainingInDegree = new Map(steps.map((step) => [step.id, stepEdges(step).length]));
  const dependentsOf = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of stepEdges(step)) {
      const dependents = dependentsOf.get(dep.id) ?? [];
      dependents.push(step.id);
      dependentsOf.set(dep.id, dependents);
    }
  }

  const ready = steps.filter((step) => remainingInDegree.get(step.id) === 0).map((step) => step.id);
  const orderedIds: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0));
    const nextId = ready.shift();
    if (nextId === undefined) break;
    orderedIds.push(nextId);
    for (const dependentId of dependentsOf.get(nextId) ?? []) {
      const remaining = (remainingInDegree.get(dependentId) ?? 0) - 1;
      remainingInDegree.set(dependentId, remaining);
      if (remaining === 0) ready.push(dependentId);
    }
  }

  if (orderedIds.length !== steps.length) return null;
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  // SAFETY: every id in `orderedIds` came from the same `steps` array.
  return orderedIds.map((id) => stepsById.get(id) as AnyStep<TOptions>);
}

export interface CompiledPipelineGraph<TOptions extends object> {
  readonly compiledByAuthorStep: ReadonlyMap<AnyStep<TOptions>, CompiledStep<TOptions>>;
  readonly orderedSteps: readonly CompiledStep<TOptions>[];
  readonly stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>;
}

export function compilePipelineGraph<TOptions extends object>(
  steps: readonly AnyStep<TOptions>[],
  compiledCaches: ReadonlyMap<AnyStep, CompiledStepCache<TOptions>> = new Map()
): CompiledPipelineGraph<TOptions> {
  const orderedAuthorSteps = topologicalSort(steps)!;
  const compiledByAuthorStep = new Map<AnyStep<TOptions>, CompiledStep<TOptions>>(
    orderedAuthorSteps.map((step) => [step, compileStep(step, compiledCaches.get(step))])
  );
  const orderedSteps = orderedAuthorSteps.map((step) => compiledByAuthorStep.get(step)!);
  const stepGraph = new Map<AnyStep, CompiledStepGraph>(
    orderedAuthorSteps.map((step) => {
      const compiled = compiledByAuthorStep.get(step)!;
      return [compiled, snapshotCompiledStepGraph(step, compiledByAuthorStep)];
    })
  );
  return { compiledByAuthorStep, orderedSteps, stepGraph };
}
