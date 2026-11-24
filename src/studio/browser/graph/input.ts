import type { StoredRunSummary } from "../../../run-store/run-history.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../../../run-store/run-store.js";
import type { StudioChildStep } from "../../shared/schema.js";

export const graphRunId = (run: GraphRun): string => run.runId ?? `definition:${run.pipelineId}`;

export function graphKey(
  kind: "run" | "step" | "item" | "edge",
  ...ids: readonly string[]
): string {
  return JSON.stringify([kind, ...ids]);
}

/** Declared step data plus the execution fields graph views can display when present. */
export type GraphStep = Omit<StoredPipelineStep, "status"> &
  Partial<Pick<StoredPipelineStep, "status">>;

/** Only run data consumed by graph scenes and inspectors. */
export type GraphRun = Pick<StoredPipelineRun, "pipelineId" | "agentTurn"> &
  Partial<Pick<StoredPipelineRun, "runId" | "startedAtMs" | "logs" | "error">> & {
    readonly steps: readonly GraphStep[];
  };

/** A recorded run, or a definition-only graph with no fabricated execution state. */
export interface GraphDetail {
  readonly run: GraphRun;
  readonly children?: readonly StoredRunSummary[];
  readonly childSteps?: readonly StudioChildStep[];
}
