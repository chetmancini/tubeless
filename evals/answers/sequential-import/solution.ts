import { createSteps, definePipeline, requireOutputs } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const loadRows = step("load-rows", {
  description: "Read caller-provided lines.",
  run: (_inputs, context) => context.options.lines,
});

const normalizeRows = step("normalize-rows", {
  dependsOn: [loadRows],
  description: "Normalize non-empty values.",
  run: ({ "load-rows": lines }) =>
    lines.map((line) => line.trim()).filter((line) => line.length > 0),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [loadRows, normalizeRows],
  targets: [normalizeRows],
  finalize: requireOutputs([normalizeRows], (outputs) => ({
    count: outputs["normalize-rows"].length,
    values: outputs["normalize-rows"],
  })),
});
