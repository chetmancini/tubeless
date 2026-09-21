import { definePipelineProject } from "tubeless/project";

// Checked-in command catalog. Module paths resolve from this file; cwd is
// this directory. Adapt IDs and files to the consumer; keep registrations
// explicit. Start with definePipelineCommand(pipeline) for schema-backed flags;
// params/mapOptions are advanced input adapters. See ../automatic-cli.ts.
// CLI argv still uses --step/--target; mapOptions and hooks
// receive stepIds, targets, and maxConcurrency. Opt in to parallel DAG execution
// with run(options, { maxConcurrency: 4 }) or --max-concurrency 4 in the CLI
// (also exposed in Studio forms). Both default to serial execution. Fail-fast drains active steps without cancelling them; final
// reports use plan order. See ../parallel-dag.ts for independent branches and a join.
// For CPU work, ../worker-threads.ts uses an explicit Node worker adapter. Compile
// its worker module to JavaScript and let the application own the pool's close().

/** Checked-in project command catalog with stable registered identities. */
export default definePipelineProject({
  cwd: ".",
  commands: [
    {
      id: "validated-import",
      file: "../automatic-cli.ts",
      export: "ValidatedCommand",
      name: "Import with inferred flags",
    },
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
