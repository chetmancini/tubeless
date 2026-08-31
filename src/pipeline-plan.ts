import { formatPipelineError } from "./pipeline-diagnostics.js";
import type { AnyStep, Step, StepOutput } from "./pipeline-steps.js";
import type {
  InferSchemaInput,
  PipelineError,
  PipelineErrorCode,
  PipelineErrorKind,
  PipelineErrorPhase,
  PipelineExecutionContext,
  PipelineMermaidOptions,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRunControls,
  PipelineStepReport,
  PipelineStepSelectionReason,
  PipelineStepSkipReason,
  PipelineStepSkippedReport,
  StandardSchemaV1,
} from "./pipeline-types.js";

export const PIPELINE_FINALIZE_STEP_ID = "__finalize__";

export const STEP_OPTIONS_SCHEMA: unique symbol = Symbol("tubeless.stepOptionsSchema");
export const STEP_NESTED_PIPELINE: unique symbol = Symbol("tubeless.stepNestedPipeline");
export const STEP_REMOTE: unique symbol = Symbol("tubeless.stepRemote");
export const REQUIRED_FINALIZER_OUTPUTS: unique symbol = Symbol(
  "tubeless.requiredFinalizerOutputs"
);
export const EXECUTE_COMPILED_RUN: unique symbol = Symbol("tubeless.executeCompiledRun");

const compiledPipelines = new WeakSet<object>();

/** Marks the exact object returned by `definePipeline` as a compiled pipeline. */
export function brandCompiledPipeline(pipeline: object): void {
  compiledPipelines.add(pipeline);
}

/** True only for the object `definePipeline` returned, not `Object.create` wrappers. */
export function isCompiledPipeline(pipeline: object): boolean {
  return compiledPipelines.has(pipeline);
}

export interface CompiledStepGraph<TOptions extends object = object> {
  readonly dependsOn: readonly AnyStep<TOptions>[];
  readonly optionalDependsOn: readonly AnyStep<TOptions>[];
  readonly skipAfterFailureOf: readonly AnyStep<TOptions>[];
}

function liveStepGraph<TOptions extends object>(
  step: AnyStep<TOptions>
): CompiledStepGraph<TOptions> {
  return {
    dependsOn: step.dependsOn ?? [],
    optionalDependsOn: step.optionalDependsOn ?? [],
    skipAfterFailureOf: step.skipAfterFailureOf ?? [],
  };
}

function freezeStepList<TOptions extends object>(
  steps: readonly AnyStep<TOptions>[] | undefined
): readonly AnyStep<TOptions>[] {
  return Object.freeze([...(steps ?? [])]);
}

function snapshotCompiledStepGraph<TOptions extends object>(
  step: AnyStep<TOptions>
): CompiledStepGraph<TOptions> {
  return Object.freeze({
    dependsOn: freezeStepList(step.dependsOn),
    optionalDependsOn: freezeStepList(step.optionalDependsOn),
    skipAfterFailureOf: freezeStepList(step.skipAfterFailureOf),
  });
}

export function compiledStepGraph<TOptions extends object>(
  compiled: Pick<CompiledPipeline, "stepGraph">,
  step: AnyStep<TOptions>
): CompiledStepGraph<TOptions> {
  const graph = compiled.stepGraph.get(step);
  if (graph === undefined) {
    throw new Error(`Compiled pipeline graph is missing step ${step.id}`);
  }
  // SAFETY: compile stores each original step object as the map key.
  return graph as CompiledStepGraph<TOptions>;
}

/**
 * Recovers the options type from the steps themselves rather than taking it as its own
 * generic parameter. A `TOptions` parameter constrained by `TSteps extends
 * readonly AnyStep<TOptions>[]` is self-referential — TypeScript can't solve that at a
 * `definePipeline(...)` call site and silently widens `TOptions` to its bare
 * `object` constraint (context.options would lose every pipeline-specific
 * field). Structuring it as "derive TOptions from TSteps" instead of "constrain TSteps by
 * TOptions" avoids the cycle, so callers never write out any of these type parameters.
 */
export type StepsOptions<TSteps extends readonly AnyStep[]> =
  TSteps[number] extends AnyStep<infer TOptions> ? TOptions : object;

export type StepsInputOptions<TSteps extends readonly AnyStep[]> =
  TSteps[number] extends Step<string, unknown, object, infer TInputOptions, infer _TRunOut>
    ? TInputOptions
    : StepsOptions<TSteps>;

export type StepIds<TSteps extends readonly AnyStep[]> = TSteps[number]["id"];

export type TargetIds<TTargets extends readonly AnyStep[]> = TTargets[number]["id"];

export function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right));
}

function pipelineDiagnostic(
  code: PipelineErrorCode,
  phase: PipelineErrorPhase,
  kind: PipelineErrorKind,
  message: string,
  fields: Pick<PipelineError, "stepId"> = {}
): PipelineError {
  return { code, kind, message, phase, ...fields };
}

/** Required dependencies are met when completed, or intentionally policy-skipped. */
function isRequiredDependencyMet(report: PipelineStepReport | undefined): boolean {
  if (!report) return false;
  if (report.status === "completed") return true;
  return report.status === "skipped" && report.reason === "policy";
}

type StepDispositionInput<TOptions extends object> = {
  dryRun: boolean;
  graph: CompiledStepGraph<TOptions>;
  planned: PipelinePlanStep;
  reportsByStepId: ReadonlyMap<string, PipelineStepReport>;
  step: AnyStep<TOptions>;
};

type StepDisposition =
  | { kind: "run" }
  | {
      kind: "skip";
      reason: PipelineStepSkipReason;
      dependencyId?: string;
      message?: string;
    };

/**
 * Single skip ladder for plan and live execution.
 * Policy skips stay outside: they run only after a step is scheduled.
 * Remainder copies plan `skipReason` for structural skips and marks planned-run
 * steps fail-fast or cancelled, so this ladder has no abort/fail-fast mode.
 */
export function decideStepDisposition<TOptions extends object>(
  input: StepDispositionInput<TOptions>
): StepDisposition {
  const { dryRun, graph, planned, reportsByStepId, step } = input;

  if (!planned.selected) {
    return { kind: "skip", reason: "filtered" };
  }

  const unsuccessfulAncestor = graph.skipAfterFailureOf.find((dep) => {
    const status = reportsByStepId.get(dep.id)?.status;
    return status === "failed" || status === "cancelled";
  });
  if (unsuccessfulAncestor) {
    return {
      kind: "skip",
      reason: "failed-dependency",
      dependencyId: unsuccessfulAncestor.id,
    };
  }

  const unmetDependency = graph.dependsOn.find(
    (dep) => !isRequiredDependencyMet(reportsByStepId.get(dep.id))
  );
  if (unmetDependency) {
    return {
      kind: "skip",
      reason: "unmet-dependency",
      dependencyId: unmetDependency.id,
    };
  }

  if (dryRun && skipsInDryRun(step)) {
    return { kind: "skip", reason: "dry-run" };
  }

  return { kind: "run" };
}

/**
 * Deduplicated by object identity: the same dependency commonly appears in more than one
 * of these arrays (e.g. a step that's both `optionalDependsOn` and `skipAfterFailureOf` the
 * same upstream step). Without dedup, `topologicalSort`'s in-degree count would no longer
 * equal the number of distinct prerequisites — harmless there since the inflated count and
 * the duplicated `dependentsOf` entries cancel out, but confusing to read and a latent trap
 * for future callers of this helper that assume it returns distinct edges.
 */
function stepEdges<TOptions extends object>(
  step: AnyStep<TOptions>,
  graph: CompiledStepGraph<TOptions> = liveStepGraph(step)
): readonly AnyStep<TOptions>[] {
  return [
    ...new Set([...graph.dependsOn, ...graph.optionalDependsOn, ...graph.skipAfterFailureOf]),
  ];
}

/** Required data and failure-gate closure for dependency-aware targets. */
function targetClosure<TOptions extends object>(
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

/**
 * Orders `steps` so every dependency runs before its dependents, using each step's
 * original array position to break ties. For an array that's already in valid dependency
 * order (true of every hand-ordered pipeline today) this provably reproduces that same
 * order — each step becomes eligible (in-degree 0) at the same point it would've been
 * reached by a plain declaration-order walk. What it adds is tolerance for a `steps` array
 * that ISN'T already ordered, and a real error instead of silent misbehavior on a cycle.
 * Returns null if the graph has a cycle (shouldn't happen given `const`-reference
 * construction, but the executor should never spin or drop steps if it somehow does).
 */
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
    if (nextId === undefined) {
      break;
    }
    orderedIds.push(nextId);
    for (const dependentId of dependentsOf.get(nextId) ?? []) {
      const remaining = (remainingInDegree.get(dependentId) ?? 0) - 1;
      remainingInDegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
      }
    }
  }

  if (orderedIds.length !== steps.length) {
    return null;
  }
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  // SAFETY: every id in `orderedIds` was produced by walking the same `steps`
  // array, so the map lookup always finds the matching `AnyStep<TOptions>`.
  return orderedIds.map((id) => stepsById.get(id) as AnyStep<TOptions>);
}

function escapeMermaidLabel(value: string): string {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/#/g, "#35;")
    .replace(/&/g, "#38;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#60;")
    .replace(/>/g, "#62;");
}

export function renderPipelineMermaid<TOptions extends object>(
  steps: readonly AnyStep<TOptions>[],
  options: PipelineMermaidOptions,
  stepGraph?: ReadonlyMap<AnyStep, CompiledStepGraph>
): string {
  const direction = options.direction ?? "TD";
  if (!(["BT", "LR", "RL", "TB", "TD"] as const).includes(direction)) {
    throw new Error(`Invalid Mermaid flowchart direction: ${direction}`);
  }
  const nodeIdByStep = new Map(steps.map((step, index) => [step, `step${index}`]));
  const lines = [`flowchart ${direction}`];

  for (const step of steps) {
    const nodeId = nodeIdByStep.get(step)!;
    const displayName = step.name ?? step.id;
    const label =
      options.includeDescriptions && step.description
        ? `${displayName} — ${step.description}`
        : displayName;
    lines.push(`  ${nodeId}["${escapeMermaidLabel(label)}"]`);
  }

  const edgeLines: string[] = [];
  for (const step of steps) {
    const graph = stepGraph?.get(step) ?? liveStepGraph(step);
    const targetId = nodeIdByStep.get(step)!;
    const required = new Set(graph.dependsOn);
    const optional = new Set(graph.optionalDependsOn);
    const failureGates = new Set(graph.skipAfterFailureOf);

    for (const dependency of stepEdges(step, graph)) {
      const sourceId = nodeIdByStep.get(dependency)!;
      if (required.has(dependency)) {
        edgeLines.push(`  ${sourceId} --> ${targetId}`);
        continue;
      }
      if (optional.has(dependency) && failureGates.has(dependency)) {
        edgeLines.push(`  ${sourceId} -. optional input + failure gate .-> ${targetId}`);
        continue;
      }
      if (optional.has(dependency)) {
        edgeLines.push(`  ${sourceId} -. optional input .-> ${targetId}`);
        continue;
      }
      edgeLines.push(`  ${sourceId} -. failure gate .-> ${targetId}`);
    }
  }

  if (edgeLines.length > 0) {
    lines.push("", ...edgeLines);
  }
  return `${lines.join("\n")}\n`;
}

export function stepToPlanStep<TOptions extends object>(
  step: AnyStep<TOptions>,
  selected: boolean,
  skipReason?: PipelineStepSkipReason,
  selectionReasons?: readonly PipelineStepSelectionReason[],
  graph: CompiledStepGraph<TOptions> = liveStepGraph(step)
): PipelinePlanStep {
  const reasons = selectionReasons ?? [{ kind: "all" }];
  const planStep: PipelinePlanStep = {
    dependencies: graph.dependsOn.map((dep) => dep.id),
    description: step.description,
    dryRun: step.dryRun === "skip" ? "skip" : step.dryRun !== undefined ? "custom" : "run",
    id: step.id,
    name: step.name,
    optionalDependencies: graph.optionalDependsOn.map((dep) => dep.id),
    runtimeSkipPossible: step.skip !== undefined,
    selected,
    selectionReasons: reasons,
    skipAfterFailureOf: graph.skipAfterFailureOf.map((dep) => dep.id),
    skipReason,
  };
  if (step[STEP_NESTED_PIPELINE]) {
    planStep.nestedPipeline = {
      ...step[STEP_NESTED_PIPELINE],
      stepIds: [...step[STEP_NESTED_PIPELINE].stepIds],
    };
  }
  if (step[STEP_REMOTE]) {
    planStep.remote = { ...step[STEP_REMOTE] };
  }
  return planStep;
}

function addSelectionReason(
  reasonsByStepId: Map<string, PipelineStepSelectionReason[]>,
  stepId: string,
  reason: PipelineStepSelectionReason
): void {
  const reasons = reasonsByStepId.get(stepId) ?? [];
  const reasonKey = JSON.stringify(reason);
  if (!reasons.some((candidate) => JSON.stringify(candidate) === reasonKey)) {
    reasons.push(reason);
    reasonsByStepId.set(stepId, reasons);
  }
}

function targetSelectionReasons<TOptions extends object>(
  targets: readonly AnyStep<TOptions>[],
  stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>
): Map<string, PipelineStepSelectionReason[]> {
  const reasonsByStepId = new Map<string, PipelineStepSelectionReason[]>();

  for (const target of targets) {
    addSelectionReason(reasonsByStepId, target.id, { kind: "target", targetId: target.id });
    const expanded = new Set<AnyStep<TOptions>>();
    const includePrerequisites = (step: AnyStep<TOptions>): void => {
      if (expanded.has(step)) return;
      expanded.add(step);

      const graph = compiledStepGraph({ stepGraph }, step);
      for (const dependency of graph.dependsOn) {
        addSelectionReason(reasonsByStepId, dependency.id, {
          dependentId: step.id,
          kind: "required-dependency",
          targetId: target.id,
        });
        includePrerequisites(dependency);
      }
      for (const dependency of graph.skipAfterFailureOf) {
        addSelectionReason(reasonsByStepId, dependency.id, {
          dependentId: step.id,
          kind: "failure-gate",
          targetId: target.id,
        });
        includePrerequisites(dependency);
      }
      for (const dependency of graph.optionalDependsOn) {
        addSelectionReason(reasonsByStepId, dependency.id, {
          dependentId: step.id,
          kind: "optional-only",
          targetId: target.id,
        });
      }
    };
    includePrerequisites(target);
  }

  return reasonsByStepId;
}

function selectsStep(reason: PipelineStepSelectionReason): boolean {
  return !["not-selected", "optional-only", "outside-target-closure"].includes(reason.kind);
}

function skipsInDryRun<TOptions extends object>(step: AnyStep<TOptions>): boolean {
  return step.dryRun === "skip";
}

export function validatePipelineDefinition<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(definition: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema>): PipelineError[] {
  type TOptions = StepsOptions<TSteps>;
  const steps = definition.steps;
  const errors: PipelineError[] = [];
  if (definition.id.trim().length === 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_PIPELINE_ID_BLANK",
        "definition",
        "definition",
        "Pipeline id must not be blank"
      )
    );
  }

  const stepIds = steps.map((step) => step.id);
  const duplicateStepIds = duplicateValues(stepIds);
  if (duplicateStepIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE",
        "definition",
        "definition",
        `Pipeline ${definition.id} has duplicate step ids: ${duplicateStepIds.join(", ")}`
      )
    );
  }
  const optionsSchemas = new Set(steps.map((step) => step[STEP_OPTIONS_SCHEMA]));
  if (optionsSchemas.size > 1 && [...optionsSchemas].some(Boolean)) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_OPTIONS_SCHEMA_CONFLICT",
        "definition",
        "definition",
        `Pipeline ${definition.id} mixes steps from different options-schema scopes`
      )
    );
  }
  for (const step of steps) {
    if (step.id.trim().length === 0) {
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_DEFINITION_STEP_ID_BLANK",
          "definition",
          "definition",
          `Pipeline ${definition.id} has a step with a blank id`,
          { stepId: step.id }
        )
      );
    }
    if (step.id === PIPELINE_FINALIZE_STEP_ID) {
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_DEFINITION_STEP_ID_RESERVED",
          "definition",
          "definition",
          `Pipeline ${definition.id} uses reserved step id ${PIPELINE_FINALIZE_STEP_ID}`,
          { stepId: step.id }
        )
      );
    }
    if (step.name !== undefined && step.name.trim().length === 0) {
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_DEFINITION_STEP_NAME_BLANK",
          "definition",
          "definition",
          `Pipeline ${definition.id} step ${step.id} has a blank display name`,
          { stepId: step.id }
        )
      );
    }
    const dependencyGroups = [
      ["dependsOn", step.dependsOn ?? []],
      ["optionalDependsOn", step.optionalDependsOn ?? []],
      ["skipAfterFailureOf", step.skipAfterFailureOf ?? []],
    ] as const;
    for (const [field, dependencies] of dependencyGroups) {
      const duplicates = duplicateValues(dependencies.map((dependency) => dependency.id));
      if (duplicates.length > 0) {
        errors.push(
          pipelineDiagnostic(
            "TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE",
            "definition",
            "definition",
            `Pipeline ${definition.id} step ${step.id} repeats ${field}: ${duplicates.join(", ")}`,
            { stepId: step.id }
          )
        );
      }
      if (dependencies.includes(step)) {
        errors.push(
          pipelineDiagnostic(
            "TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE",
            "definition",
            "definition",
            `Pipeline ${definition.id} step ${step.id} cannot reference itself in ${field}`,
            { stepId: step.id }
          )
        );
      }
    }

    const required = new Set(step.dependsOn ?? []);
    const contradictory = (step.optionalDependsOn ?? []).filter((dependency) =>
      required.has(dependency)
    );
    if (contradictory.length > 0) {
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY",
          "definition",
          "definition",
          `Pipeline ${definition.id} step ${step.id} declares dependencies as both required and optional: ${contradictory.map(({ id }) => id).join(", ")}`,
          { stepId: step.id }
        )
      );
    }
  }

  // SAFETY: `steps` is `TSteps extends readonly AnyStep[]`; the cast restores
  // the `TOptions` generic that the tuple erased, without changing the values.
  const knownSteps = new Set<AnyStep<TOptions>>(steps as readonly AnyStep<TOptions>[]);
  // SAFETY: targets are a subset of `TSteps[number]`, each an `AnyStep<TOptions>`.
  const declaredTargets = (definition.targets ?? []) as readonly AnyStep<TOptions>[];
  const duplicateTargetIds = duplicateValues(declaredTargets.map((target) => target.id));
  if (duplicateTargetIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_TARGETS_DUPLICATE",
        "definition",
        "definition",
        `Pipeline ${definition.id} declares duplicate targets: ${duplicateTargetIds.join(", ")}`
      )
    );
  }
  const missingTargets = declaredTargets.filter((target) => !knownSteps.has(target));
  if (missingTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_TARGET_NOT_IN_STEPS",
        "definition",
        "definition",
        `Pipeline ${definition.id} declares target step(s) not included in its steps list: ${missingTargets.map(({ id }) => id).join(", ")}`
      )
    );
  }
  const missingReferences: string[] = [];
  // SAFETY: `steps` is `TSteps extends readonly AnyStep[]`; the cast restores the
  // `TOptions` generic that the tuple erased, without changing the values.
  for (const step of steps as readonly AnyStep<TOptions>[]) {
    for (const dependency of stepEdges(step)) {
      if (!knownSteps.has(dependency)) {
        missingReferences.push(`${step.id} -> ${dependency.id}`);
      }
    }
  }
  if (missingReferences.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS",
        "definition",
        "definition",
        `Pipeline ${definition.id} references step(s) not included in its steps list: ${missingReferences.join(", ")}`
      )
    );
  }

  // SAFETY: `requireOutputs` stamps the required step ids onto the finalizer
  // function under `REQUIRED_FINALIZER_OUTPUTS`; the intersection only widens
  // the function type to expose that optional property.
  const requiredFinalizerSteps = (
    definition.finalize as typeof definition.finalize & {
      [REQUIRED_FINALIZER_OUTPUTS]?: readonly AnyStep<TOptions>[];
    }
  )[REQUIRED_FINALIZER_OUTPUTS];
  const missingFinalizerSteps = (requiredFinalizerSteps ?? []).filter(
    (step) => !knownSteps.has(step)
  );
  if (missingFinalizerSteps.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS",
        "definition",
        "definition",
        `Pipeline ${definition.id} requires finalizer output from step(s) not included in its steps list: ${missingFinalizerSteps.map(({ id }) => id).join(", ")}`
      )
    );
  }

  if (
    requiredFinalizerSteps &&
    missingTargets.length === 0 &&
    missingReferences.length === 0 &&
    missingFinalizerSteps.length === 0
  ) {
    for (const target of declaredTargets) {
      const selected = targetClosure([target]);
      const missingRequiredSteps = requiredFinalizerSteps.filter((step) => !selected.has(step));
      if (missingRequiredSteps.length > 0) {
        errors.push(
          pipelineDiagnostic(
            "TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH",
            "definition",
            "definition",
            `Pipeline ${definition.id} target ${target.id} cannot satisfy required finalizer output(s): ${missingRequiredSteps.map(({ id }) => id).join(", ")}`,
            { stepId: target.id }
          )
        );
      }
    }
  }

  // SAFETY: `steps` is `TSteps extends readonly AnyStep[]`; the cast restores the
  // `TOptions` generic that the tuple erased, without changing the values.
  if (errors.length === 0 && !topologicalSort(steps as readonly AnyStep<TOptions>[])) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_DEFINITION_DEPENDENCY_CYCLE",
        "definition",
        "definition",
        `Pipeline ${definition.id} has a dependency cycle`
      )
    );
  }
  return errors;
}

export function buildPipelinePlan<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(
  compiled: CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>,
  controls: PipelineRunControls<StepIds<TSteps>, TargetIds<TTargets>>
): PipelinePlan {
  const dryRun = controls.dryRun === true;
  const steps = compiled.orderedSteps;
  const errors: PipelineError[] = [];

  const knownStepIds = new Set(compiled.stepIds);
  const declaredTargetIds = new Set(compiled.declaredTargets.map((target) => target.id));
  const requestedStepIds = controls.stepIds ?? [];
  const requestedTargets = controls.targets ?? [];
  if (controls.stepIds !== undefined && controls.targets !== undefined) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_SELECTION_CONFLICT",
        "planning",
        "selection",
        `Pipeline ${compiled.id} cannot combine exact stepIds filtering with dependency-aware targets`
      )
    );
  }
  if (controls.stepIds !== undefined && controls.stepIds.length === 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
        "planning",
        "selection",
        `Pipeline ${compiled.id} received an empty stepIds array; omit stepIds to run every step, or pass at least one step id`
      )
    );
  }
  if (controls.targets !== undefined && controls.targets.length === 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_SELECTION_EMPTY",
        "planning",
        "selection",
        `Pipeline ${compiled.id} received an empty targets array; omit targets to run every step, or pass at least one target step id`
      )
    );
  }
  const duplicateRequestedStepIds = duplicateValues(requestedStepIds);
  if (duplicateRequestedStepIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested duplicate step ids: ${duplicateRequestedStepIds.join(", ")}`
      )
    );
  }
  const unknownRequestedStepIds = requestedStepIds.filter((stepId) => !knownStepIds.has(stepId));
  if (unknownRequestedStepIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_UNKNOWN",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested unknown step ids: ${unknownRequestedStepIds.join(", ")}`
      )
    );
  }
  const duplicateTargets = duplicateValues(requestedTargets);
  if (duplicateTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested duplicate targets: ${duplicateTargets.join(", ")}`
      )
    );
  }
  const unknownTargets = requestedTargets.filter((stepId) => !knownStepIds.has(stepId));
  if (unknownTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_UNKNOWN",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested unknown targets: ${unknownTargets.join(", ")}`
      )
    );
  }
  const undeclaredTargets = requestedTargets.filter(
    (stepId) => knownStepIds.has(stepId) && !declaredTargetIds.has(stepId)
  );
  if (undeclaredTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_UNDECLARED",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested undeclared targets: ${undeclaredTargets.join(", ")}`
      )
    );
  }

  const orderedSteps = steps;

  if (errors.length > 0) {
    return {
      dryRun,
      errors,
      ok: false,
      pipelineId: compiled.id,
      steps: [],
    };
  }

  let selectionReasonsByStepId: Map<string, PipelineStepSelectionReason[]>;
  if (controls.stepIds !== undefined) {
    const selectedIds = new Set(controls.stepIds);
    selectionReasonsByStepId = new Map(
      steps.map((step) => [
        step.id,
        selectedIds.has(step.id)
          ? ([{ kind: "exact" }] satisfies PipelineStepSelectionReason[])
          : ([{ kind: "not-selected" }] satisfies PipelineStepSelectionReason[]),
      ])
    );
  } else if (controls.targets !== undefined) {
    const stepsById = new Map(steps.map((step) => [step.id, step]));
    const selectedTargets = controls.targets.map((target) => stepsById.get(target)!);
    selectionReasonsByStepId = targetSelectionReasons(selectedTargets, compiled.stepGraph);
    for (const step of steps) {
      const reasons = selectionReasonsByStepId.get(step.id) ?? [];
      const selected = reasons.some(selectsStep);
      selectionReasonsByStepId.set(
        step.id,
        selected
          ? reasons.filter(selectsStep)
          : reasons.length > 0
            ? reasons
            : [{ kind: "outside-target-closure" }]
      );
    }
  } else {
    selectionReasonsByStepId = new Map(
      steps.map((step) => [step.id, [{ kind: "all" }] satisfies PipelineStepSelectionReason[]])
    );
  }
  const planSteps: PipelinePlanStep[] = [];
  // Accumulated planned skip/complete reports so later steps see the same
  // unmet-dependency chain as today's skipReason walk (not one empty map).
  const plannedReportsByStepId = new Map<string, PipelineStepReport>();
  for (const step of orderedSteps) {
    const selectionReasons = selectionReasonsByStepId.get(step.id)!;
    const selected = selectionReasons.some(selectsStep);
    const graph = compiledStepGraph(compiled, step);
    const planned = stepToPlanStep(step, selected, undefined, selectionReasons, graph);
    const disposition = decideStepDisposition({
      dryRun,
      graph,
      planned,
      reportsByStepId: plannedReportsByStepId,
      step,
    });
    const skipReason = disposition.kind === "skip" ? disposition.reason : undefined;
    const planStep = stepToPlanStep(step, selected, skipReason, selectionReasons, graph);
    planSteps.push(planStep);
    if (disposition.kind === "skip") {
      const report: PipelineStepSkippedReport = {
        id: step.id,
        name: step.name,
        description: step.description,
        finishedAtMs: 0,
        reason: disposition.reason,
        status: "skipped",
      };
      if (disposition.dependencyId) report.dependencyId = disposition.dependencyId;
      if (disposition.message) report.message = disposition.message;
      plannedReportsByStepId.set(step.id, report);
    } else {
      // Synthetic complete so isRequiredDependencyMet treats will-run deps as met.
      plannedReportsByStepId.set(step.id, {
        attemptId: "",
        id: step.id,
        name: step.name,
        description: step.description,
        finishedAtMs: 0,
        startedAtMs: 0,
        status: "completed",
      });
    }
  }

  return {
    dryRun,
    errors,
    ok: errors.length === 0,
    pipelineId: compiled.id,
    steps: planSteps,
  };
}

export function planStepById(plan: PipelinePlan): Map<string, PipelinePlanStep> {
  return new Map(plan.steps.map((step) => [step.id, step]));
}

/** Programmer error raised immediately when a pipeline graph is invalid. */
export class PipelineDefinitionError extends Error {
  constructor(
    readonly pipelineId: string,
    readonly errors: readonly PipelineError[]
  ) {
    super(
      errors.length > 0
        ? `Invalid pipeline ${pipelineId}: ${errors.map((error) => formatPipelineError(error)).join("; ")}`
        : `Invalid pipeline ${pipelineId}`
    );
    this.name = "PipelineDefinitionError";
  }
}

export interface CompiledPipeline<
  TSteps extends readonly AnyStep[] = readonly AnyStep[],
  TResult = unknown,
  TTargets extends readonly TSteps[number][] = readonly [],
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
  readonly declaredTargets: readonly AnyStep<StepsOptions<TSteps>>[];
  readonly finalize: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema>["finalize"];
  readonly id: string;
  readonly optionsSchema: StandardSchemaV1 | undefined;
  readonly orderedSteps: readonly AnyStep<StepsOptions<TSteps>>[];
  readonly requiredFinalizerSteps: readonly AnyStep<StepsOptions<TSteps>>[] | undefined;
  readonly stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>;
  readonly resultSchema: TResultSchema | undefined;
  readonly stepIds: readonly string[];
  readonly targetIds: readonly string[];
}

export function compilePipeline<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(
  definition: PipelineDefinition<TSteps, TResult, TTargets, TResultSchema>
): CompiledPipeline<TSteps, TResult, TTargets, TResultSchema> {
  const errors = validatePipelineDefinition(definition);
  if (errors.length > 0) {
    throw new PipelineDefinitionError(definition.id, errors);
  }
  type TOptions = StepsOptions<TSteps>;
  // SAFETY: `steps` is `TSteps extends readonly AnyStep[]`; the cast restores
  // the `TOptions` generic that the tuple erased, without changing the values.
  const orderedSteps = topologicalSort(definition.steps as readonly AnyStep<TOptions>[])!;
  // Keep the author's step objects so class private accessors and prototype
  // `run`/`skip` keep working. Graph arrays live in compiled storage so frozen
  // or later-mutated caller-owned steps cannot change planning.
  const stepGraph = new Map<AnyStep, CompiledStepGraph>(
    orderedSteps.map((step) => [step, snapshotCompiledStepGraph(step)])
  );
  // SAFETY: `requireOutputs` stamps the required step ids onto the finalizer
  // function under `REQUIRED_FINALIZER_OUTPUTS`; the intersection only widens
  // the function type to expose that optional property.
  const requiredFinalizerSteps = (
    definition.finalize as typeof definition.finalize & {
      [REQUIRED_FINALIZER_OUTPUTS]?: readonly AnyStep<TOptions>[];
    }
  )[REQUIRED_FINALIZER_OUTPUTS];
  // SAFETY: targets are a subset of `TSteps[number]`, each an `AnyStep<TOptions>`.
  const declaredTargets = (definition.targets ?? []) as readonly AnyStep<TOptions>[];
  return Object.freeze({
    declaredTargets: Object.freeze([...declaredTargets]),
    // Invoke on the author's definition so method-style finalizers keep `this`.
    // SAFETY: the wrapper only forwards to `definition.finalize`.
    finalize: ((outputs, context) =>
      definition.finalize(outputs, context)) as typeof definition.finalize,
    id: definition.id,
    optionsSchema: definition.steps[0]?.[STEP_OPTIONS_SCHEMA],
    orderedSteps: Object.freeze([...orderedSteps]),
    stepGraph,
    requiredFinalizerSteps: requiredFinalizerSteps
      ? Object.freeze([...requiredFinalizerSteps])
      : undefined,
    resultSchema: definition.resultSchema,
    stepIds: Object.freeze(definition.steps.map((step) => step.id)),
    targetIds: Object.freeze((definition.targets ?? []).map((step) => step.id)),
  });
}

type PipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]: StepOutput<S>;
};

type RequiredPipelineOutputs<TSteps extends readonly AnyStep[]> = {
  [S in TSteps[number] as S["id"]]-?: StepOutput<S>;
};

/**
 * Build a finalizer that only runs when every listed step published an output.
 * Presence is checked by output slot, so a successfully published `undefined`
 * remains distinct from a structural skip or failure.
 */
export function requireOutputs<const TRequiredSteps extends readonly AnyStep[], TResult>(
  requiredSteps: TRequiredSteps,
  finalize: (
    outputs: RequiredPipelineOutputs<TRequiredSteps>,
    context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
  ) => TResult | Promise<TResult>
): (
  outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
  context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
) => TResult | Promise<TResult> {
  const uniqueRequiredSteps = [...new Set(requiredSteps)];
  const requiredFinalizer = (
    outputs: Partial<RequiredPipelineOutputs<TRequiredSteps>>,
    context: PipelineExecutionContext<StepsOptions<TRequiredSteps>>
  ) => {
    const missingStepIds = uniqueRequiredSteps
      .filter((step) => !Object.prototype.hasOwnProperty.call(outputs, step.id))
      .map((step) => step.id);
    if (missingStepIds.length > 0) {
      throw new Error(`Required pipeline outputs missing: ${missingStepIds.join(", ")}`);
    }
    // SAFETY: every required step id was verified present above, so the partial
    // outputs contain all required keys and are a complete required-outputs map.
    return finalize(outputs as unknown as RequiredPipelineOutputs<TRequiredSteps>, context);
  };
  Object.defineProperty(requiredFinalizer, REQUIRED_FINALIZER_OUTPUTS, {
    value: uniqueRequiredSteps,
  });
  return requiredFinalizer;
}

export interface PipelineDefinition<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][] = readonly [],
  TResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
  id: string;
  steps: TSteps;
  /** Public downstream goals that callers may select with `targets`. */
  targets?: TTargets;
  /** Optional Standard Schema for the finalized result. */
  resultSchema?: TResultSchema;
  finalize(
    outputs: Partial<PipelineOutputs<TSteps>>,
    context: PipelineExecutionContext<StepsOptions<TSteps>>
  ):
    | (TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult)
    | Promise<TResultSchema extends StandardSchemaV1 ? InferSchemaInput<TResultSchema> : TResult>;
}
