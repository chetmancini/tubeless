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

const normalizedImport = step.fromPipeline("normalized-import", {
  dependsOn: [loadRows],
  description: "Normalize rows through the independently useful child pipeline.",
  pipeline: NormalizePipeline,
  mapOptions: ({ "load-rows": rows }) => ({ rows }),
  mapResult: (rows) => ({ count: rows.length, rows }),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [loadRows, normalizedImport],
  targets: [normalizedImport],
  finalize: requireOutputs([normalizedImport], (outputs) => outputs["normalized-import"]),
});
