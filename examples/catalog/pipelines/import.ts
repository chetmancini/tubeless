import { createSteps, definePipeline, requireOutputs } from "tubeless";
import { NormalizePipeline } from "./normalize.ts";

interface ImportOptions {
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const loadRows = step("load-rows", {
  description: "Read raw input records from the caller.",
  run: (_inputs, context) => context.options.lines,
});

const normalizedImport = step.forEachPipeline.skippable("normalized-import", {
  dependsOn: [loadRows],
  description: "Normalize rows through mapped child pipelines when input is present.",
  pipeline: NormalizePipeline,
  skip: ({ "load-rows": rows }) =>
    rows.length === 0 ? { reason: "no rows to normalize", value: [] } : false,
  items: ({ "load-rows": rows }) => rows,
  key: (_row, index) => String(index),
  mapOptions: (row) => ({ rows: [row] }),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [loadRows, normalizedImport],
  targets: [normalizedImport],
  finalize: requireOutputs([normalizedImport], (outputs) => {
    const rows = (outputs["normalized-import"] ?? []).flat();
    return { count: rows.length, rows };
  }),
});
