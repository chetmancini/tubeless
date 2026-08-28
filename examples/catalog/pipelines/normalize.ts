import { createSteps, definePipeline, requireOutputs } from "tubeless";

interface NormalizeOptions {
  rows: readonly string[];
}

const step = createSteps<NormalizeOptions>();

const normalizeRows = step("normalize-rows", {
  description: "Trim, lowercase, and drop blank rows.",
  run: (_inputs, context) =>
    context.options.rows.map((row) => row.trim().toLowerCase()).filter((row) => row.length > 0),
});

export const NormalizePipeline = definePipeline({
  id: "normalize",
  steps: [normalizeRows],
  targets: [normalizeRows],
  finalize: requireOutputs([normalizeRows], (outputs) => outputs["normalize-rows"]),
});
