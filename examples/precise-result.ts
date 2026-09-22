import { createSteps, definePipeline, type PipelineResult } from "tubeless";

const { step } = createSteps<{ text: string }>();

const load = step("load", {
  run: (_inputs, context) => context.options.text,
});

const count = step("count", {
  dependsOn: [load],
  run: ({ load }) => load.length,
});

export const CountPipeline = definePipeline({
  id: "count-characters",
  steps: [load, count],
  // Require this output and return it directly; no finalizer callback is needed.
  finalize: count,
});

export type CountResult = PipelineResult<typeof CountPipeline>; // number

export async function runPreciseResultExample(): Promise<number> {
  return CountPipeline.runOrThrow({ text: "hello" });
}
