import { createSteps, definePipeline } from "tubeless";

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

// The last declared step is both the public target and the default result.
export const MinimalPipeline = definePipeline({
  id: "minimal",
  steps: [load, normalize],
});

export async function runMinimalExample() {
  return MinimalPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
}
