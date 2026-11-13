import { PROJECT_TARGET } from "./workbench-command-specs.js";
import type { ProjectScaffold } from "./workbench-init.js";
import { DEFAULT_PIPELINE_PROJECT_FILE } from "./workbench-project-loader.js";

// Interpolated so the runtime graph checks do not mistake template text for an import of this module.
const STARTER_PIPELINE_IMPORT = "./pipelines/import.js";

/** Mirrors the README quick start so the first project and the first program agree. */
const STARTER_PIPELINE = `import { createSteps, definePipeline } from "tubeless";

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
`;

export const projectScaffold: ProjectScaffold = {
  ...PROJECT_TARGET,
  loadsProject: false,
  files() {
    return [
      {
        path: DEFAULT_PIPELINE_PROJECT_FILE,
        contents: `import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ImportPipeline } from "${STARTER_PIPELINE_IMPORT}";

// Register each pipeline exactly once. Pipelines with a Standard JSON Schema
// options schema can be listed directly; this one is type-only, so its command
// adapter declares the CLI flags.
export default defineProject("my-app", [
  definePipelineCommand(ImportPipeline, {
    params: {
      lines: { type: "string", multiple: true, description: "A line to normalize (repeatable)" },
    },
  }),
]);
`,
      },
      { path: "pipelines/import.ts", contents: STARTER_PIPELINE },
    ];
  },
  nextSteps: [
    "bun add tubeless   # or npm install tubeless / pnpm add tubeless",
    "bunx tubeless list",
    "bunx tubeless plan import",
    "bunx tubeless run import -- --help",
    'bunx tubeless run import -- --lines " Alpha " --lines Beta',
    "Guide: https://tubeless.io/docs/getting-started",
  ],
};
