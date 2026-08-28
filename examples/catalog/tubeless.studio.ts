import { definePipelineStudio } from "tubeless/workbench/studio";

export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand", name: "Publish artifact" },
  ],
});
