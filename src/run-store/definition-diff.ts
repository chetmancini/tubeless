import type { PipelineDefinitionSnapshot } from "../core/pipeline.js";

export interface DefinitionChange {
  stepId?: string;
  field: string;
  before?: string;
  after?: string;
}

/** Compare complete recorded semantics, without loading the application's modules. */
export function compareDefinitions(
  before: PipelineDefinitionSnapshot,
  after: PipelineDefinitionSnapshot
): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const compare = (field: string, left: unknown, right: unknown, stepId?: string) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    if (a !== b) changes.push({ field, before: a, after: b, ...(stepId ? { stepId } : {}) });
  };
  compare(
    "Implementation version",
    before.identity.implementationVersion,
    after.identity.implementationVersion
  );
  compare(
    "Execution order",
    before.steps.map(({ id }) => id),
    after.steps.map(({ id }) => id)
  );
  compare("Metadata", before.metadata, after.metadata);
  compare("Targets", before.targetIds, after.targetIds);
  compare(
    "Required finalizer steps",
    before.requiredFinalizerStepIds,
    after.requiredFinalizerStepIds
  );
  compare("Options validation", before.optionsValidated, after.optionsValidated);
  compare("Result validation", before.resultValidated, after.resultValidated);
  const previous = new Map(before.steps.map((step) => [step.id, step]));
  const next = new Map(after.steps.map((step) => [step.id, step]));
  for (const step of before.steps) {
    if (!next.has(step.id)) changes.push({ stepId: step.id, field: "Removed step" });
  }
  for (const step of after.steps) {
    const old = previous.get(step.id);
    if (!old) {
      changes.push({ stepId: step.id, field: "Added step" });
      continue;
    }
    compare("Metadata", old.metadata, step.metadata, step.id);
    compare("Required edges", old.dependencies, step.dependencies, step.id);
    compare("Optional edges", old.optionalDependencies, step.optionalDependencies, step.id);
    compare("Failure gates", old.skipAfterFailureOf, step.skipAfterFailureOf, step.id);
    compare("Dry-run policy", old.dryRun, step.dryRun, step.id);
    compare("Skip policy", old.runtimeSkipPossible, step.runtimeSkipPossible, step.id);
    compare("Output validation", old.outputValidated, step.outputValidated, step.id);
    compare("Child pipeline", old.nestedPipeline, step.nestedPipeline, step.id);
    compare("Remote adapter", old.remote, step.remote, step.id);
  }
  return changes;
}
