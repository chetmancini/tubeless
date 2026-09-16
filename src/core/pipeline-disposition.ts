import type { CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  PipelinePlanStep,
  PipelineStepReport,
  PipelineStepSkipReason,
} from "./pipeline-types.js";

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

  if (dryRun && step.dryRun === "skip") {
    return { kind: "skip", reason: "dry-run" };
  }

  return { kind: "run" };
}
