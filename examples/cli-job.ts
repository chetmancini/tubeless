import * as fs from "fs";
import { createSteps, definePipeline, requireOutputs } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";

interface ImportOptions {
  lines: readonly string[];
  limit?: number;
}

const step = createSteps<ImportOptions>();

const loadRows = step("load-rows", {
  description: "Read raw input records from the caller.",
  run: (_inputs, context) => context.options.lines,
});

const normalizeRows = step("normalize-rows", {
  dependsOn: [loadRows],
  description: "Trim, lowercase, drop blanks, and apply the optional --limit.",
  run: ({ "load-rows": rows }, context) => {
    const normalized = rows.map((row) => row.trim().toLowerCase()).filter((row) => row.length > 0);
    return context.options.limit === undefined
      ? normalized
      : normalized.slice(0, context.options.limit);
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

/**
 * The kind of entry point a `scripts/*.ts` file would export: flags become a typed,
 * validated `args` object instead of hand-parsed `process.argv`. `--source`'s `path` type
 * resolves relative to `context.cwd` and confirms the file exists before `run` sees it.
 * Pipeline commands also provide exact `--step`, dependency-aware `--target`
 * for the pipeline's declared goals, and `--continue-on-error`, while
 * forwarding the universal `--dry-run` flag into the pipeline automatically.
 * Inspect, plan, or graph this command export. Plan with `command.plan()` or
 * `tubeless plan`, not `--plan`.
 */
export const ImportCommand = definePipelineCommand(ImportPipeline, {
  description: "Normalize a newline-delimited list of input rows.",
  params: {
    source: {
      type: "path",
      description: "File with one row per line.",
      mustExist: true,
      kind: "file",
    },
    limit: {
      type: "number",
      optional: true,
      integer: true,
      min: 1,
      description: "Only keep the first N normalized rows.",
    },
  },
  mapOptions: (args) => ({
    lines: fs.readFileSync(args.source, "utf8").split("\n"),
    limit: args.limit,
  }),
  summarize: (result) => [`Normalized ${result.count} row(s).`],
});

if (false) {
  const missingLinesParams = { source: { type: "path" } } as const;
  // @ts-expect-error --source does not supply ImportPipeline's required lines option.
  definePipelineCommand(ImportPipeline, { params: missingLinesParams });

  const renamedOptionalParams = {
    lines: { type: "string", multiple: true },
    max: { type: "number", optional: true },
  } as const;
  // @ts-expect-error --max is not a same-name option on ImportPipeline.
  definePipelineCommand(ImportPipeline, { params: renamedOptionalParams });
}

if (import.meta.main) {
  void ImportCommand.main();
}
