import type { CompiledStep } from "./pipeline-graph.js";
import type { PipelineStepReportStatus, PipelineStepSkipReason } from "./pipeline-types.js";

export type DependencyState =
  | { status: Exclude<PipelineStepReportStatus, "skipped"> }
  | { status: "skipped"; reason: PipelineStepSkipReason };

export function hasPublishedOutput(state: DependencyState | undefined): boolean {
  return (
    state?.status === "completed" || (state?.status === "skipped" && state.reason === "policy")
  );
}

type StepDispositionInput<TOptions extends object> = {
  dryRun: boolean;
  hasReplacementOutput?: boolean;
  selected: boolean;
  dependencyStates: ReadonlyMap<string, DependencyState>;
  step: CompiledStep<TOptions>;
};

type StepDisposition =
  | { kind: "run" }
  | {
      kind: "skip";
      reason: PipelineStepSkipReason;
      dependencyId?: string;
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
  const { dryRun, selected, hasReplacementOutput, dependencyStates, step } = input;

  if (!selected) {
    return { kind: "skip", reason: "filtered" };
  }
  if (hasReplacementOutput) return { kind: "run" };

  const unsuccessfulAncestor = step.skipAfterFailureOf.find((dep) => {
    const status = dependencyStates.get(dep.id)?.status;
    return status === "failed" || status === "cancelled";
  });
  if (unsuccessfulAncestor) {
    return {
      kind: "skip",
      reason: "failed-dependency",
      dependencyId: unsuccessfulAncestor.id,
    };
  }

  const unmetDependency = step.dependsOn.find(
    (dep) => !hasPublishedOutput(dependencyStates.get(dep.id))
  );
  if (unmetDependency) {
    return {
      kind: "skip",
      reason: "unmet-dependency",
      dependencyId: unmetDependency.id,
    };
  }

  if (dryRun && step.dryRun === "skip") {
    return { kind: "skip", reason: "dry-run" };
  }

  return { kind: "run" };
}
