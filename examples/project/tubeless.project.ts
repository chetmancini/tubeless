import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ValidatedPipeline } from "../validated-boundaries.ts";
import { YamlImportCommand, YamlPreviewCommand } from "../yaml-pipelines.ts";
import { YamlPelotonCommand } from "../yaml-peloton.ts";
import { NormalizePipeline } from "./pipelines/normalize.ts";
import { EnrichCommand } from "./scripts/enrich.ts";
import { ImportCommand } from "./scripts/import.ts";
import { PublishCommand } from "./scripts/publish.ts";

// One project serves application code, CLI, and Studio. Pipeline IDs are the
// command IDs. Schema-backed pipelines need no command adapter; explicit commands
// handle type-only inputs, custom params/mapOptions, and presentation.
export default defineProject(
  "example-jobs",
  [
    ValidatedPipeline,
    // Register the entry pipelines; their compiled children remain implementation details.
    YamlImportCommand,
    YamlPreviewCommand,
    YamlPelotonCommand,
    definePipelineCommand(NormalizePipeline, {
      params: { rows: { type: "string", multiple: true } },
    }),
    ImportCommand,
    EnrichCommand,
    PublishCommand,
  ],
  {
    name: "Example jobs",
    description: "Import, enrich, and publish row datasets.",
  }
);
