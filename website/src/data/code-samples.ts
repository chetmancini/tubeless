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

export const PROJECT_SAMPLE = `import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ImportPipeline } from "./pipeline.js";

export default defineProject("data-jobs", [
  definePipelineCommand(ImportPipeline, {
    params: { lines: { type: "string", multiple: true } },
  }),
], {
  name: "Data jobs",
});`;
