import type { PipelineError, PipelinePlan, PipelinePlanStep, PipelineStepSelectionReason } from "./pipeline.js";
import { formatPipelineError } from "./pipeline-diagnostics.js";

export interface PipelineHumanRenderOptions {
  /** Human-readable output. This is the default format. */
  format?: "human";
}

export interface PipelineJsonRenderOptions {
  /** Machine-readable output containing the original structured fields. */
  format: "json";
  /** Indent JSON output by two spaces. Defaults to false for stream-friendly output. */
  pretty?: boolean;
}

export type PipelineRenderOptions = PipelineHumanRenderOptions | PipelineJsonRenderOptions;

export type PipelinePlanRenderOptions =
  | (PipelineHumanRenderOptions & {
      /** Include structured selection provenance and runtime-skip annotations. Defaults to true. */
      explain?: boolean;
    })
  | PipelineJsonRenderOptions;

function renderJson<T>(value: T, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

/** Render one structured diagnostic for a person or a machine consumer. */
export function renderPipelineError(
  error: PipelineError,
  options: PipelineRenderOptions = {}
): string {
  if (options.format === "json") return renderJson(error, options.pretty);
  return formatPipelineError(error);
}

function describeRemote(step: PipelinePlanStep, planDryRun: boolean): string {
  if (!step.remote) return "";
  const target = step.remote.target ? ` (${step.remote.target})` : "";
  const label = `remote ${step.remote.engine}${target}`;
  const contactsEngine =
    planDryRun && step.dryRun === "run" && step.selected && step.skipReason === undefined;
  return contactsEngine ? ` -> ${label}; dry-run contacts engine` : ` -> ${label}`;
}

function describeSelectionReason(reason: PipelineStepSelectionReason): string | undefined {
  switch (reason.kind) {
    case "all":
      return undefined;
    case "exact":
      return "exact selection";
    case "target":
      return `target ${reason.targetId}`;
    case "required-dependency":
      return `required by ${reason.dependentId} for target ${reason.targetId}`;
    case "failure-gate":
      return `failure gate for ${reason.dependentId} for target ${reason.targetId}`;
    case "optional-only":
      return `optional-only input to ${reason.dependentId} for target ${reason.targetId}`;
    case "outside-target-closure":
      return "outside target closure";
    case "not-selected":
      return "not selected";
  }
}

/** Render an execution plan without recomputing selection or dependency provenance. */
export function renderPipelinePlan(
  plan: PipelinePlan,
  options: PipelinePlanRenderOptions = {}
): string {
  if (options.format === "json") return renderJson(plan, options.pretty);

  const explain = options.explain !== false;
  const lines = [
    `Pipeline ${plan.pipelineId}: plan (ok=${plan.ok}, dryRun=${plan.dryRun}, steps=${plan.steps.length})`,
  ];
  for (const step of plan.steps) {
    const displayName = step.name ? `${step.name} [${step.id}]` : step.id;
    const annotations = explain
      ? step.selectionReasons
          .map(describeSelectionReason)
          .filter((detail): detail is string => detail !== undefined)
      : [];
    if (explain && !step.skipReason && step.runtimeSkipPossible) {
      annotations.unshift("policy may skip");
    }
    const disposition = `${step.skipReason ? `skip: ${step.skipReason}` : "run"}${
      annotations.length > 0 ? ` (${annotations.join("; ")})` : ""
    }`;
    const nested = step.nestedPipeline
      ? ` -> ${step.nestedPipeline.mode === "for-each" ? "fan-out" : "child"} pipeline ${step.nestedPipeline.pipelineId} (${step.nestedPipeline.stepIds.length} declared steps)`
      : "";
    const remote = describeRemote(step, plan.dryRun);
    lines.push(
      `  - ${displayName}: ${disposition}${nested}${remote}${step.description ? ` - ${step.description}` : ""}`
    );
  }
  for (const error of plan.errors) {
    lines.push(`  ! ${renderPipelineError(error)}`);
  }
  return lines.join("\n");
}
