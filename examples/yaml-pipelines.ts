import { defineProject } from "tubeless/project";
import { definePipelineCommand } from "tubeless/cli";
import document from "./declarative/pipelines.yaml";
import { registry } from "./declarative/handlers.ts";

// This loader uses Bun's native YAML import. Node applications can pass the
// result of their chosen YAML parser (or JSON.parse) to defineProject.
// Document metadata supplies project.name and project.description. An optional
// fourth argument can override either field without changing pipeline identities.
export const project = defineProject("yaml-examples", document, registry);

const params = {
  lines: { type: "string", description: "Comma-separated input rows." },
} as const;

function command(id: string) {
  const pipeline = project.get(id);
  return definePipelineCommand(pipeline, {
    name: id === "yaml-import" ? "Import rows from YAML" : "Preview rows from YAML",
    description: `Run ${id} from the YAML document.`,
    params,
    mapOptions: ({ lines }) => ({ lines: lines.split(",") }),
    summarize: (result) => [JSON.stringify(result)],
  });
}

export const YamlImportCommand = command("yaml-import");
export const YamlPreviewCommand = command("yaml-preview");
