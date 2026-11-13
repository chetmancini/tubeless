import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ImportPipeline } from "./pipelines/import.js";

// Register each pipeline exactly once. Pipelines with a Standard JSON Schema
// options schema can be listed directly; this one is type-only, so its command
// adapter declares the CLI flags.
export default defineProject("my-app", [
  definePipelineCommand(ImportPipeline, {
    params: {
      lines: { type: "string", multiple: true, description: "A line to normalize (repeatable)" },
    },
  }),
]);
