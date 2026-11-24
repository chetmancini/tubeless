import type { StoredPipelineEvent } from "./run-store.js";

export function copyStepPlan({
  name,
  description,
  dependencies,
  optionalDependencies,
  skipAfterFailureOf,
  nestedPipeline,
  remote,
}: Extract<StoredPipelineEvent, { name: "step.planned" }>["payload"]) {
  return {
    name,
    description,
    dependencies: [...dependencies],
    optionalDependencies: [...optionalDependencies],
    skipAfterFailureOf: [...skipAfterFailureOf],
    ...(nestedPipeline
      ? { nestedPipeline: { ...nestedPipeline, stepIds: [...nestedPipeline.stepIds] } }
      : {}),
    ...(remote ? { remote: { ...remote } } : {}),
  };
}
