import { snapshotPipelineMetadata } from "../tracing/graph-metadata.js";
import type { CompiledStepCache } from "./pipeline-cache.js";
import type { AnyStep } from "./pipeline-steps.js";
import {
  STEP_CACHE,
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  STEP_REMOTE,
  STEP_AGENT,
  STEP_ORCHESTRATION,
} from "./pipeline-step-metadata.js";

/** Frozen step snapshot whose normalized dependency arrays reference compiled steps. */
export interface CompiledStep<TOptions extends object = object> extends AnyStep<TOptions> {
  readonly dependsOn: readonly CompiledStep<TOptions>[];
  readonly optionalDependsOn: readonly CompiledStep<TOptions>[];
  readonly skipAfterFailureOf: readonly CompiledStep<TOptions>[];
}

type CompiledStepEdges<TOptions extends object> = Pick<
  CompiledStep<TOptions>,
  "dependsOn" | "optionalDependsOn" | "skipAfterFailureOf"
>;

function compileStep<TOptions extends object>(
  step: AnyStep<TOptions>,
  cache: CompiledStepCache<TOptions> | undefined,
  edges: CompiledStepEdges<TOptions>
): CompiledStep<TOptions> {
  const nestedPipeline = step[STEP_NESTED_PIPELINE];
  const remote = step[STEP_REMOTE];
  const optionsSchema = step[STEP_OPTIONS_SCHEMA];
  const agent = step[STEP_AGENT];
  const name = step.name;
  const description = step.description;
  const metadata = snapshotPipelineMetadata(step.metadata);
  const dryRun = step.dryRun;
  const outputSchema = step.outputSchema;
  const skip = step.skip;
  const compiled = {
    id: step.id,
    run: step.run.bind(step),
    ...edges,
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
  if (step[STEP_ORCHESTRATION]) Object.assign(compiled, { [STEP_ORCHESTRATION]: true });
  if (agent !== undefined) Object.assign(compiled, { [STEP_AGENT]: agent });
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

/** Normalized edges of an author or compiled step, deduplicated across policies. */
export function stepEdges<TOptions extends object>(
  step: AnyStep<TOptions>
): readonly AnyStep<TOptions>[] {
  return [
    ...new Set([
      ...(step.dependsOn ?? []),
      ...(step.optionalDependsOn ?? []),
      ...(step.skipAfterFailureOf ?? []),
    ]),
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
}

/**
 * Snapshot topologically ordered author steps. Each step compiles after its
 * dependencies, so its frozen edge arrays reference their compiled snapshots.
 */
export function compilePipelineGraph<TOptions extends object>(input: {
  orderedSteps: readonly AnyStep<TOptions>[];
  compiledCaches?: ReadonlyMap<AnyStep, CompiledStepCache<TOptions>>;
}): CompiledPipelineGraph<TOptions> {
  const { orderedSteps: orderedAuthorSteps, compiledCaches = new Map() } = input;
  const compiledByAuthorStep = new Map<AnyStep<TOptions>, CompiledStep<TOptions>>();
  const compileDependencies = (
    step: AnyStep<TOptions>,
    dependencies: readonly AnyStep<TOptions>[] | undefined
  ): readonly CompiledStep<TOptions>[] =>
    Object.freeze(
      (dependencies ?? []).map((dependency) => {
        const compiled = compiledByAuthorStep.get(dependency);
        if (compiled === undefined) {
          throw new Error(
            `Compiled pipeline graph requires dependency ${dependency.id} before step ${step.id}`
          );
        }
        return compiled;
      })
    );
  const orderedSteps = orderedAuthorSteps.map((step) => {
    const compiled = compileStep(step, compiledCaches.get(step), {
      dependsOn: compileDependencies(step, step.dependsOn),
      optionalDependsOn: compileDependencies(step, step.optionalDependsOn),
      skipAfterFailureOf: compileDependencies(step, step.skipAfterFailureOf),
    });
    compiledByAuthorStep.set(step, compiled);
    return compiled;
  });
  return { compiledByAuthorStep, orderedSteps };
}
