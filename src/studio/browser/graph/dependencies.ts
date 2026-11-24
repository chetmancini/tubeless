import type { GraphStep } from "./input.js";
import { producedStepOutput, tripsFailureGate } from "../step-outcome.js";

export type EdgeState =
  | "active"
  | "blocked"
  | "candidate"
  | "settled"
  | "tripped"
  | "unused"
  | "used";

export type EdgeKind = "input" | "optional" | "gate";

export function incomingEdges(step: GraphStep): Map<string, EdgeKind[]> {
  const edges = new Map<string, EdgeKind[]>();
  const add = (ids: readonly string[] | undefined, kind: EdgeKind) => {
    for (const id of ids ?? []) edges.set(id, [...(edges.get(id) ?? []), kind]);
  };
  add(step.dependencies, "input");
  add(step.optionalDependencies, "optional");
  add(step.skipAfterFailureOf, "gate");
  return edges;
}

/**
 * Visual state of one dependency edge from all of its kinds and its endpoint steps.
 * Gates trip on a failed or cancelled source, matching the engine's step disposition.
 * A step's own skip policy runs after its inputs are built, so a policy skip still
 * received them; other skips happen before inputs exist.
 */
export function edgeState(
  kinds: readonly EdgeKind[],
  source: GraphStep,
  target: GraphStep
): EdgeState {
  const gate = kinds.includes("gate");
  const failed = tripsFailureGate(source.status);
  if (gate && failed) return "tripped";
  if (target.status === undefined || target.status === "planned") return "candidate";
  if (kinds.length === 1 && gate) return "settled";
  if (!producedStepOutput(source)) return failed ? "blocked" : "unused";
  if (target.status === "running") return "active";
  return target.status === "skipped" && target.skipReason !== "policy" ? "unused" : "used";
}
