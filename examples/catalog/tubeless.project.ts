import { definePipelineProject } from "tubeless/workbench/project";

// This project manifest is the deterministic interface for people, agents, and
// the local studio. Module paths resolve from this file; cwd controls command
// execution. Command argv flags stay --step/--target, while mapOptions and hooks
// receive stepIds and targets.
// History uses recorded pipeline IDs: `tubeless history --pipeline import`
// selects the pipeline behind the registered command `import-rows`.

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
