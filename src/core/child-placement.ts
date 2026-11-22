import type {
  Pipeline,
  PipelineContext,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
} from "./pipeline-types.js";

/** Private host capability for explicit child composition. */
export const CHILD_PLACEMENT: unique symbol = Symbol("tubeless.childPlacement");

export type ChildPlacement = (input: {
  pipeline: Pipeline<object, unknown, string, string>;
  plan: PipelinePlan;
  options: object;
  controls: PipelineRunControls;
  context: PipelineContext;
  stepId: string;
}) => Promise<PipelineRun<unknown>> | undefined;

export function childPlacement(context: PipelineContext): ChildPlacement | undefined {
  return (context as PipelineContext & { [CHILD_PLACEMENT]?: ChildPlacement })[CHILD_PLACEMENT];
}
