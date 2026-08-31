import { definePipelineStudio } from "tubeless/workbench/studio";

// Recorded studio history keeps last reportProgress details and nestedPipeline
// labels from these commands. Use --store when launching so that structure
// survives after the live TTY closes.
// Command argv flags stay --step/--target; mapOptions and hooks receive stepIds
// and targets.

/** Checked-in catalog. Studio can cancel one live launch from the running detail pane without stopping the server. */
export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/enrich.ts", export: "EnrichCommand", name: "Enrich rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand", name: "Publish artifact" },
  ],
});
