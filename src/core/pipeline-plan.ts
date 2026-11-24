import { duplicateValues } from "../utilities/collections.js";
import { didYouMean } from "../utilities/suggest.js";
import { isStepCachePolicy } from "../tracing/tracing-constants.js";
import type { CompiledPipeline } from "./pipeline-compiler.js";
import type { StepIds, TargetIds } from "./pipeline-definition.js";
import { decideStepDisposition, type DependencyState } from "./pipeline-disposition.js";
import { pipelineDiagnostic } from "./pipeline-errors.js";
import { targetClosure, type CompiledStep } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import { STEP_NESTED_PIPELINE, STEP_REMOTE, STEP_AGENT } from "./pipeline-step-metadata.js";
import type {
  PipelineError,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRunControls,
  PipelineStepSelectionReason,
  PipelineStepSkipReason,
  StandardSchemaV1,
} from "./pipeline-types.js";

function stepToPlanStep<TOptions extends object>(
  step: CompiledStep<TOptions>,
  selected: boolean,
  skipReason: PipelineStepSkipReason | undefined,
  selectionReasons: readonly PipelineStepSelectionReason[]
): PipelinePlanStep {
  const planStep: PipelinePlanStep = {
    dependencies: step.dependsOn.map((dep) => dep.id),
    description: step.description,
    ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
    dryRun: step.dryRun === "skip" ? "skip" : step.dryRun !== undefined ? "custom" : "run",
    id: step.id,
    name: step.name,
    optionalDependencies: step.optionalDependsOn.map((dep) => dep.id),
    runtimeSkipPossible: step.skip !== undefined,
    selected,
    selectionReasons,
    skipAfterFailureOf: step.skipAfterFailureOf.map((dep) => dep.id),
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
  if (step[STEP_AGENT]) planStep.agent = step[STEP_AGENT];
  return planStep;
}

function targetSelectionReasons<TOptions extends object>(
  targets: readonly CompiledStep<TOptions>[]
): Map<string, PipelineStepSelectionReason[]> {
  const reasonsByStepId = new Map<string, PipelineStepSelectionReason[]>();

  function addReason(stepId: string, reason: PipelineStepSelectionReason): void {
    const reasons = reasonsByStepId.get(stepId);
    if (reasons) reasons.push(reason);
    else reasonsByStepId.set(stepId, [reason]);
  }

  for (const target of targets) {
    addReason(target.id, { kind: "target", targetId: target.id });
    targetClosure(target, (dependency, dependent, kind) => {
      addReason(dependency.id, { dependentId: dependent.id, kind, targetId: target.id });
    });
  }

  return reasonsByStepId;
}

function selectsStep(reason: PipelineStepSelectionReason): boolean {
  return !["not-selected", "optional-only", "outside-target-closure"].includes(reason.kind);
}

/** Selection modes conflict when both controls are present, including empty arrays. */
export function hasConflictingSelectionControls(controls: {
  stepIds?: readonly string[];
  targets?: readonly string[];
}): boolean {
  return controls.stepIds !== undefined && controls.targets !== undefined;
}

function selectionSuggestions(ids: readonly string[], candidates: readonly string[]): string[] {
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.flatMap((id) => {
    const suggestion = didYouMean(id, candidates);
    if (suggestion === undefined) return [];
    return [
      uniqueIds.length === 1 ? suggestion : `${suggestion.slice(0, -1)} for ${JSON.stringify(id)}?`,
    ];
  });
}

function targetHints(
  pipelineId: string,
  ids: readonly string[],
  declaredTargetIds: ReadonlySet<string>
): string[] {
  const declared = [...declaredTargetIds];
  const hints = selectionSuggestions(ids, declared);
  if (hints.length < new Set(ids).size) {
    hints.push(
      declared.length === 0
        ? `Pipeline ${pipelineId} declares no targets.`
        : `Declared targets: ${declared.join(", ")}.`
    );
  }
  return hints;
}

function withHints(message: string, hints: readonly string[]): string {
  return hints.length === 0 ? message : `${message}. ${hints.join(" ")}`;
}

export function buildPipelinePlan<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(
  compiled: CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>,
  controls: PipelineRunControls<StepIds<TSteps>, TargetIds<TTargets>>,
  admissionErrors: readonly PipelineError[] = []
): PipelinePlan {
  const dryRun = controls.dryRun === true;
  const steps = compiled.orderedSteps;
  const errors: PipelineError[] = [...admissionErrors];
  const invalidPlan: PipelinePlan = {
    dryRun,
    errors,
    ok: false,
    pipelineId: compiled.id,
    definition: compiled.definition,
    steps: [],
  };

  const knownSteps = compiled.stepsById;
  const declaredTargetIds = new Set(compiled.targetIds);
  const requestedStepIds = controls.stepIds ?? [];
  const requestedTargets = controls.targets ?? [];
  for (const stepId of controls.suppliedOutputs?.keys() ?? []) {
    if (!knownSteps.has(stepId))
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID",
          "planning",
          "validation",
          "suppliedOutputs contains an unknown step ID"
        )
      );
  }
  if (controls.cache !== undefined && !isStepCachePolicy(controls.cache)) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_RUN_CACHE_INVALID",
        "planning",
        "validation",
        "cache must be use, recompute, or bypass"
      )
    );
  }
  const maxConcurrency = controls.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_RUN_CONCURRENCY_INVALID",
        "planning",
        "validation",
        "maxConcurrency must be a positive finite integer"
      )
    );
  }
  if (hasConflictingSelectionControls(controls)) {
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
  const unknownRequestedStepIds = requestedStepIds.filter((stepId) => !knownSteps.has(stepId));
  if (unknownRequestedStepIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_UNKNOWN",
        "planning",
        "selection",
        withHints(
          `Pipeline ${compiled.id} requested unknown step ids: ${unknownRequestedStepIds.join(", ")}`,
          selectionSuggestions(unknownRequestedStepIds, compiled.stepIds)
        )
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
  const unknownTargets = requestedTargets.filter((stepId) => !knownSteps.has(stepId));
  if (unknownTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_UNKNOWN",
        "planning",
        "selection",
        withHints(
          `Pipeline ${compiled.id} requested unknown targets: ${unknownTargets.join(", ")}`,
          targetHints(compiled.id, unknownTargets, declaredTargetIds)
        )
      )
    );
  }
  const undeclaredTargets = requestedTargets.filter(
    (stepId) => knownSteps.has(stepId) && !declaredTargetIds.has(stepId)
  );
  if (undeclaredTargets.length > 0) {
    const uniqueUndeclared = [...new Set(undeclaredTargets)];
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_UNDECLARED",
        "planning",
        "selection",
        withHints(
          `Pipeline ${compiled.id} requested undeclared targets: ${undeclaredTargets.join(", ")}`,
          [
            uniqueUndeclared.length === 1
              ? `${JSON.stringify(uniqueUndeclared[0])} is a step, not a declared target; select steps exactly with stepIds.`
              : "These are steps, not declared targets; select steps exactly with stepIds.",
            ...targetHints(compiled.id, undeclaredTargets, declaredTargetIds),
          ]
        )
      )
    );
  }

  if (errors.length > 0) return invalidPlan;

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
    const selectedTargets = controls.targets.map((target) => compiled.stepsById.get(target)!);
    selectionReasonsByStepId = targetSelectionReasons(selectedTargets);
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
  for (const stepId of controls.suppliedOutputs?.keys() ?? []) {
    if (!selectionReasonsByStepId.get(stepId)?.some(selectsStep))
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID",
          "planning",
          "validation",
          "suppliedOutputs contains an unselected step ID"
        )
      );
  }
  if (errors.length > 0) return invalidPlan;
  const planSteps: PipelinePlanStep[] = [];
  const plannedStates = new Map<string, DependencyState>();
  for (const step of steps) {
    const selectionReasons = selectionReasonsByStepId.get(step.id)!;
    const selected = selectionReasons.some(selectsStep);
    const disposition = decideStepDisposition({
      dryRun,
      selected,
      hasReplacementOutput: controls.suppliedOutputs?.has(step.id),
      dependencyStates: plannedStates,
      step,
    });
    const skipReason = disposition.kind === "skip" ? disposition.reason : undefined;
    planSteps.push(stepToPlanStep(step, selected, skipReason, selectionReasons));
    plannedStates.set(
      step.id,
      disposition.kind === "skip"
        ? { status: "skipped", reason: disposition.reason }
        : { status: "completed" }
    );
  }

  return { ...invalidPlan, ok: true, steps: planSteps };
}
