import { definePipelineProject } from "tubeless/project";

// Project catalog; commands use definePipelineCommand from tubeless/cli.
// Register commands here so the CLI and coding agents can find them;
// Studio can consume the same catalog later without changing the pipelines.
// Module paths resolve from this file; cwd controls command
// execution. Command argv flags stay --step/--target, while mapOptions and hooks
// receive stepIds and targets.
// When converting existing code, use the tubeless-make-pipeline agent skill.
// Pipeline files destructure the constructors they need from createSteps.
// ../minimal-pipeline.ts shows { id, steps }: the last declared step is the default
// target and result; missing output returns undefined. Use requireOutputs to require it.
// Adding skip to any definition marks that step as intentionally omittable.
// Adapt this layout to the consumer; retain its established IDs and caller contracts.
// For caller-directed fan-out reruns, see ../fan-out-progress.ts: inspect
// error.fanOut and check omitted entries and truncated keys before selecting inputs.
// That example also shows automatic nested CLI rows and retained substep completion;
// fromPipeline and forEachPipeline forward progress without consumer hook wiring.
// Fan-outs show up to 32 live groups by default, then the full final tree.
// ../live-tui.ts shows context.log in a right-side pane in wide terminals;
// Logs appear only in the pane while visible; set reporter.logPane to "off"
// for logs above progress. Use --trace or --store for complete recordings.
// History uses recorded pipeline IDs: `tubeless history --pipeline import`
// selects the pipeline behind the registered command `import-rows`.

// ../child-pipeline.ts demonstrates fromPipeline result mapping; async mappings
// publish resolved values to parent dependents and use resolved skip values.
// ../yaml-pipelines.ts demonstrates the declarative equivalents with explicit
// fromPipelineAdapters, forEachPipelineAdapters, and skipPredicates registries.

// Remote integration recipes are library handlers rather than CLI commands:
// ../remote-steps.ts exports RemoteStepsPipeline (id: remote-steps).
// ../host-embedding.ts exports HostedPipeline (id: hosted-import) and handleHostJob.
// Register a command wrapper here only when the application owns its endpoint/config.
// Application telemetry adapters implement PipelineTraceExporter; see ../tracing.ts.
// Optional Node helpers live in tubeless/node; ../node-artifacts.ts demonstrates
// cwd-relative paths and atomic JSON writes in a step marked dryRun: "skip".
// writeJson rejects values with no JSON representation before touching disk.

/** Checked-in project command catalog with stable registered identities. */
export default definePipelineProject({
  cwd: ".",
  commands: [
    {
      id: "yaml-peloton",
      file: "../yaml-peloton.ts",
      export: "YamlPelotonCommand",
      name: "Peloton from YAML",
    },
    {
      id: "yaml-import",
      file: "../yaml-pipelines.ts",
      export: "YamlImportCommand",
      name: "Import rows from YAML",
    },
    {
      id: "yaml-preview",
      file: "../yaml-pipelines.ts",
      export: "YamlPreviewCommand",
      name: "Preview rows from YAML",
    },
    {
      id: "import-rows",
      file: "./scripts/import.ts",
      export: "ImportCommand",
      name: "Import rows",
    },
    {
      id: "enrich-rows",
      file: "./scripts/enrich.ts",
      export: "EnrichCommand",
      name: "Enrich rows",
    },
    {
      id: "publish-artifact",
      file: "./scripts/publish.ts",
      export: "PublishCommand",
      name: "Publish artifact",
    },
  ],
});
