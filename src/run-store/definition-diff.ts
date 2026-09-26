import { canonicalJsonValue } from "../utilities/canonical-json.js";
import type { PipelineDefinitionSnapshot } from "../core/pipeline.js";

export interface DefinitionChange {
  stepId?: string;
  field: string;
  before?: string;
  after?: string;
}

// Every step semantic needs a comparison label; new snapshot fields must be handled here.
const STEP_FIELDS = {
  dependencies: "Required edges",
  optionalDependencies: "Optional edges",
  skipAfterFailureOf: "Failure gates",
  dryRun: "Dry-run policy",
  runtimeSkipPossible: "Skip policy",
  outputValidated: "Output validation",
  cache: "Cache settings",
  nestedPipeline: "Child pipeline",
  remote: "Remote adapter",
} satisfies Record<
  Exclude<keyof PipelineDefinitionSnapshot["steps"][number], "id" | "metadata">,
  string
>;

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
  compare("Metadata", canonicalJsonValue(before.metadata), canonicalJsonValue(after.metadata));
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
    compare(
      "Metadata",
      canonicalJsonValue(old.metadata),
      canonicalJsonValue(step.metadata),
      step.id
    );
    for (const field of Object.keys(STEP_FIELDS)) {
      // SAFETY: keys come from the exhaustive, locally authored field map above.
      const key = field as keyof typeof STEP_FIELDS;
      compare(STEP_FIELDS[key], old[key], step[key], step.id);
    }
  }
  return changes;
}
