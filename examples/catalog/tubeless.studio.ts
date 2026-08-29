import { definePipelineStudio } from "tubeless/workbench/studio";

// Recorded studio history keeps last reportProgress details and nestedPipeline
// labels from these commands. Use --store when launching so that structure
// survives after the live TTY closes.

export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand", name: "Publish artifact" },
  ],
});
