import type { GraphStep } from "./graph/input.js";

export function tripsFailureGate(status: GraphStep["status"]): boolean {
  return status === "failed" || status === "cancelled";
}

export function producedStepOutput(step: Pick<GraphStep, "status" | "skipReason">): boolean {
  return step.status === "completed" || (step.status === "skipped" && step.skipReason === "policy");
}
