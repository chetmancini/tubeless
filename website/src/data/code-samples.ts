export const FIRST_PIPELINE_SAMPLE = `import { createSteps, definePipeline } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const { step } = createSteps<ImportOptions>();

const load = step("load", {
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  dependsOn: [load],
  run: ({ load: rows }) =>
    rows.map((row) => row.trim().toLowerCase()).filter(Boolean),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
});`;
