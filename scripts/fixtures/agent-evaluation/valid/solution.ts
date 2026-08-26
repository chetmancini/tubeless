import { createSteps, definePipeline, requireOutputs } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const load = step("load", {
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  dependsOn: [load],
  run: ({ load: lines }) => lines.map((line) => line.trim()).filter(Boolean),
});

export const ImportPipeline = definePipeline({
  id: "fixture-import",
  steps: [load, normalize],
  finalize: requireOutputs([normalize], ({ normalize }) => ({
    count: normalize.length,
    values: normalize,
  })),
});
