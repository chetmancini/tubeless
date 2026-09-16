import { duplicateValues } from "../utilities/collections.js";
import type { PipelineDefinition, StepsOptions } from "./pipeline-definition.js";
import { requiredFinalizerMetadata } from "./pipeline-finalizer.js";
import { stepEdges, targetClosure, topologicalSort } from "./pipeline-graph.js";
import { pipelineDiagnostic } from "./pipeline-errors.js";
import type { AnyStep } from "./pipeline-steps.js";
import { PIPELINE_FINALIZE_STEP_ID, STEP_OPTIONS_SCHEMA } from "./pipeline-step-metadata.js";
import type { PipelineError, StandardSchemaV1 } from "./pipeline-types.js";

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

  const requiredFinalizerSteps = requiredFinalizerMetadata<TOptions>(definition.finalize)?.steps;
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
