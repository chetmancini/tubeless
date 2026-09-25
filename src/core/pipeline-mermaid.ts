import { liveStepGraph, stepEdges, type CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import { STEP_NESTED_PIPELINE } from "./pipeline-step-metadata.js";
import { PIPELINE_MERMAID_DIRECTIONS, type PipelineMermaidOptions } from "./pipeline-types.js";

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
  if (!PIPELINE_MERMAID_DIRECTIONS.includes(direction)) {
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
    const nested = step[STEP_NESTED_PIPELINE];
    const iteration =
      nested?.mode === "iterate" ? ` (at most ${nested.maxIterations} iterations)` : "";
    lines.push(`  ${nodeId}["${escapeMermaidLabel(label + iteration)}"]`);
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

  if (edgeLines.length > 0) lines.push("", ...edgeLines);
  return `${lines.join("\n")}\n`;
}
