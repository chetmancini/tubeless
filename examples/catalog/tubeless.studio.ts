import { definePipelineStudio } from "tubeless/workbench/studio";

// Recorded studio history keeps last reportProgress details and nestedPipeline
// labels from these commands. Use --store when launching so that structure
// survives after the live TTY closes. Writers buffer up to 64 events; flush or
// close before another connection can see the tail.
// A finished --trace artifact opens separately with `tubeless ui --trace`;
// that portable view is read-only and cannot use this launch catalog.
// Command argv flags stay --step/--target; mapOptions and hooks receive stepIds
// and targets.

/** Legacy UI-only catalog. New projects should use tubeless.project.ts. */
export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/enrich.ts", export: "EnrichCommand", name: "Enrich rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand", name: "Publish artifact" },
  ],
});
