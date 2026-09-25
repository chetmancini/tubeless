import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ValidatedPipeline } from "../validated-boundaries.ts";
import { CountPipeline } from "../precise-result.ts";
import { WelcomePipeline } from "../inherited-inputs.ts";
import { YamlImportCommand, YamlPreviewCommand } from "../yaml-pipelines.ts";
import { YamlPelotonCommand } from "../yaml-peloton.ts";
import { AirflowRemoteCommand } from "../airflow/remote.ts";
import { InngestPipeline } from "../inngest/pipeline.ts";
import { TemporalPipeline } from "../temporal/pipeline.ts";
import { DagsterPipeline } from "../dagster/pipeline.ts";
import { StepFunctionsPipeline } from "../step-functions/pipeline.ts";
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
    definePipelineCommand(WelcomePipeline, {
      params: { name: { type: "string" } },
    }),
    definePipelineCommand(CountPipeline, {
      params: { text: { type: "string", required: true } },
    }),
    // Register the entry pipelines; their compiled children remain implementation details.
    YamlImportCommand,
    YamlPreviewCommand,
    YamlPelotonCommand,
    AirflowRemoteCommand,
    // Local execution of the same pipeline hosted by the Temporal Activity.
    definePipelineCommand(TemporalPipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
    // Local execution; no Inngest event is sent.
    definePipelineCommand(InngestPipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
    definePipelineCommand(DagsterPipeline, {
      params: {
        lines: { type: "string", multiple: true },
        outputPath: { type: "path", required: true },
      },
    }),
    definePipelineCommand(StepFunctionsPipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
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
