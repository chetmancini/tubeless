import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ValidatedPipeline } from "../validated-boundaries.ts";
import {
  project as yamlProject,
  YamlImportCommand,
  YamlPreviewCommand,
} from "../yaml-pipelines.ts";
import { YamlPelotonPipeline, YamlPelotonCommand } from "../yaml-peloton.ts";
import { EnrichPipeline } from "./pipelines/enrich.ts";
import { ImportPipeline } from "./pipelines/import.ts";
import { NormalizePipeline } from "./pipelines/normalize.ts";
import { PublishPipeline } from "./pipelines/publish.ts";
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
    ...yamlProject.pipelines,
    YamlPelotonPipeline,
    NormalizePipeline,
    ImportPipeline,
    EnrichPipeline,
    PublishPipeline,
  ],
  {
    name: "Example jobs",
    description: "Import, enrich, and publish row datasets.",
    commands: [
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
  }
);
