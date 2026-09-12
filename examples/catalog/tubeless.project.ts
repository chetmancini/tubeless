import { definePipelineProject } from "tubeless/workbench/project";

// This project manifest is the deterministic interface for people, agents, and
// the local studio. Module paths resolve from this file; cwd controls command
// execution. Command argv flags stay --step/--target, while mapOptions and hooks
// receive stepIds and targets.
// For caller-directed fan-out reruns, see ../fan-out-progress.ts: inspect
// error.fanOut and check omitted entries and truncated keys before selecting inputs.
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
