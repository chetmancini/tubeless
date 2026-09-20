import { definePipelineProject } from "tubeless/project";

// Checked-in command catalog. Module paths resolve from this file; cwd is
// this directory. Adapt IDs and files to the consumer; keep registrations
// explicit. CLI argv still uses --step/--target; mapOptions and hooks
// receive stepIds and targets. Direct pipeline callers can opt in to parallel
// DAG execution with run(options, { maxConcurrency: 4 }); command runs keep
// the serial default. See ../parallel-dag.ts for independent branches and a join.

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
