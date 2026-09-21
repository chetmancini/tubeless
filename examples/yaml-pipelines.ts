import { compilePipelineDocument } from "tubeless/project";
import { definePipelineCommand } from "tubeless/cli";
import document from "./declarative/pipelines.yaml";
import { registry } from "./declarative/handlers.ts";

// This loader uses Bun's native YAML import. Node applications can pass the
// result of their chosen YAML parser (or JSON.parse) to compilePipelineDocument.
// Compilation does not register a project. Callers choose which pipelines to expose
// and can reuse compiled.metadata for project presentation.
export const compiled = compilePipelineDocument(document, registry);

const params = {
  lines: { type: "string", description: "Comma-separated input rows." },
} as const;

function command(id: string) {
  const pipeline = compiled.get(id);
  return definePipelineCommand(pipeline, {
    params,
    mapOptions: ({ lines }) => ({ lines: lines.split(",") }),
    summarize: (result) => [JSON.stringify(result)],
  });
}

export const YamlImportCommand = command("yaml-import");
export const YamlPreviewCommand = command("yaml-preview");
