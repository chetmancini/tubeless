import { createSteps, definePipeline } from "tubeless";
import { createPipelineTestRuntime, overrideStep } from "tubeless/testing";

const { step } = createSteps<{ lines: readonly string[] }>();

const load = step("load", {
  run: (_inputs, context) => {
    context.log.log("Loading source rows");
    return context.options.lines;
  },
});
const normalize = step("normalize", {
  dependsOn: [load],
  run: ({ load }) => load.map((line) => line.trim().toLowerCase()).filter(Boolean),
});
const summarize = step("summarize", {
  dependsOn: [normalize],
  run: ({ normalize }) => ({ count: normalize.length, rows: normalize }),
});

export const OverrideExamplePipeline = definePipeline({
  id: "step-output-overrides",
  steps: [load, normalize, summarize],
  finalize: summarize,
});

/** Reuse the real graph while supplying an intermediate value for downstream testing. */
export async function runOverrideExample() {
  const test = createPipelineTestRuntime();
  const run = await test.run(
    OverrideExamplePipeline,
    { lines: [] },
    {
      // Exact selection excludes upstream work. An override does not select or prune steps.
      stepIds: ["normalize", "summarize"],
      overrides: [overrideStep(normalize, ["alice", "bob"])],
    }
  );
  // Both steps complete; normalize carries outputSource: "override" metadata.
  return { run, logs: test.logs };
}
