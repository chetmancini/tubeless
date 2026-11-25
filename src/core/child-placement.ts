import type {
  Pipeline,
  PipelineContext,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
  PipelineStepContext,
} from "./pipeline-types.js";

/** Private host capability shared by the installed CLI and the project runtime. */
export const CHILD_PLACEMENT: unique symbol = Symbol.for("tubeless.childPlacement.v1");

export type ChildPlacement = (input: {
  pipeline: Pipeline<object, unknown, string, string>;
  plan: PipelinePlan;
  options: object;
  controls: PipelineRunControls;
  context: PipelineContext;
  stepId: string;
  journalPath?: readonly string[];
  reportProgress: PipelineStepContext<object>["reportProgress"];
}) => Promise<PipelineRun<unknown>> | undefined;

export function childPlacement(context: PipelineContext): ChildPlacement | undefined {
  return (context as PipelineContext & { [CHILD_PLACEMENT]?: ChildPlacement })[CHILD_PLACEMENT];
}
