import { definePipelineProject } from "tubeless/workbench";

// Register commands here so the CLI, Studio, and coding agents can find them.
// Module paths resolve from this file; cwd controls command
// execution. Command argv flags stay --step/--target, while mapOptions and hooks
// receive stepIds and targets.
// When converting existing code, use the tubeless-make-pipeline agent skill.
// Adapt this layout to the consumer; retain its established IDs and caller contracts.
// For caller-directed fan-out reruns, see ../fan-out-progress.ts: inspect
// error.fanOut and check omitted entries and truncated keys before selecting inputs.
// That example also shows automatic nested CLI rows and retained substep completion;
// fromPipeline and forEachPipeline forward progress without consumer hook wiring.
// Fan-outs show up to 32 live groups by default, then the full final tree.
// History uses recorded pipeline IDs: `tubeless history --pipeline import`
// selects the pipeline behind the registered command `import-rows`.

// ../child-pipeline.ts demonstrates fromPipeline result mapping; async mappings
// publish resolved values to parent dependents and use resolved skip values.

// Remote integration recipes are library handlers rather than CLI commands:
// ../remote-steps.ts exports RemoteStepsPipeline (id: remote-steps).
// ../host-embedding.ts exports HostedPipeline (id: hosted-import) and handleHostJob.
// Register a command wrapper here only when the application owns its endpoint/config.

/** Checked-in project command catalog with stable registered identities. */
export default definePipelineProject({
  cwd: ".",
  commands: [
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
