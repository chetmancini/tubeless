import { createSteps, definePipeline } from "tubeless";

export interface ImportOptions {
  lines: readonly string[];
}

const { step } = createSteps<ImportOptions>();

const load = step("load", {
  description: "Read the lines passed on the command line.",
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  description: "Trim, lowercase, and drop blank lines.",
  dependsOn: [load],
  run: ({ load: rows }) => rows.map((row) => row.trim().toLowerCase()).filter(Boolean),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
});
