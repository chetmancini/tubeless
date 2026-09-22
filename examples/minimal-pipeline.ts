import { createSteps, definePipeline, type PipelineInput, type PipelineResult } from "tubeless";

const { step } = createSteps<{ lines: readonly string[] }>();

const load = step("load", {
  description: "Read rows supplied by the caller.",
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  description: "Trim rows and remove empty entries.",
  dependsOn: [load],
  run: ({ load }) => load.map((row) => row.trim()).filter(Boolean),
});

// Unfiltered runs select all steps. The last step supplies the default result
// and is exposed as a public goal callers can explicitly select.
export const MinimalPipeline = definePipeline({
  id: "minimal",
  steps: [load, normalize],
});

export type MinimalPipelineInput = PipelineInput<typeof MinimalPipeline>;
export type MinimalPipelineResult = PipelineResult<typeof MinimalPipeline>;

export async function runMinimalExample() {
  return MinimalPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
}
