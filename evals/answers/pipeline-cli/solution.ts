import * as fs from "node:fs";
import { createSteps, definePipeline, requireOutputs } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";

interface ImportOptions {
  concurrency?: number;
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const loadRows = step("load-rows", {
  description: "Read raw input records from the caller.",
  run: (_inputs, context) => context.options.lines,
});

const normalizeRows = step("normalize-rows", {
  dependsOn: [loadRows],
  description: "Normalize rows, capped at --concurrency rows when provided.",
  run: ({ "load-rows": rows }, context) => {
    const normalized = rows.map((row) => row.trim().toLowerCase()).filter((row) => row.length > 0);
    return context.options.concurrency === undefined
      ? normalized
      : normalized.slice(0, context.options.concurrency);
  },
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [loadRows, normalizeRows],
  targets: [normalizeRows],
  finalize: requireOutputs([normalizeRows], (outputs) => ({
    count: outputs["normalize-rows"].length,
    rows: outputs["normalize-rows"],
  })),
});

export const ImportCommand = definePipelineCommand(ImportPipeline, {
  description: "Normalize a newline-delimited list of input rows.",
  params: {
    source: {
      type: "path",
      description: "File with one row per line.",
      kind: "file",
      mustExist: true,
    },
    concurrency: {
      type: "number",
      description: "Optional positive concurrency cap.",
      integer: true,
      min: 1,
      optional: true,
    },
  },
  mapOptions: (args) => ({
    concurrency: args.concurrency,
    lines: fs.readFileSync(args.source, "utf8").split("\n"),
  }),
  summarize: (result) => [`Normalized ${result.count} row(s).`],
});
