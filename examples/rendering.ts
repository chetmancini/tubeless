import { createSteps, definePipeline, type PipelineError } from "tubeless";
import { renderPipelineError, renderPipelinePlan } from "tubeless/render";

const step = createSteps();

const load = step("load", {
  description: "Load the release inputs.",
  run: () => "artifact",
});

const publish = step("publish", {
  dependsOn: [load],
  description: "Publish the built artifact.",
  run: () => "published",
});

export const ReleasePipeline = definePipeline({
  id: "release",
  steps: [load, publish],
  targets: [publish],
  finalize: (outputs) => outputs.publish,
});

const plan = ReleasePipeline.plan({ targets: ["publish"] });

// The same structured plan backs terminal output and machine-readable tooling.
export const humanPlan = renderPipelinePlan(plan);
export const jsonPlan = renderPipelinePlan(plan, { format: "json", pretty: true });

export function renderDiagnostic(error: PipelineError, format: "human" | "json"): string {
  return format === "json"
    ? renderPipelineError(error, { format: "json" })
    : renderPipelineError(error);
}
