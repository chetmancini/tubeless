import { compilePipelineDocument } from "tubeless/project";
import { definePipelineCommand } from "tubeless/cli";
import document from "./declarative/pipelines.yaml";
import { registry } from "./declarative/handlers.ts";

// This loader uses Bun's native YAML import. Node applications can pass the
// result of their chosen YAML parser (or JSON.parse) to the same compiler.
export const pipelines = compilePipelineDocument(document, registry);

const params = {
  lines: { type: "string", description: "Comma-separated input rows." },
} as const;

function command(id: string) {
  const pipeline = pipelines.get(id);
  if (!pipeline) throw new Error(`Missing example pipeline ${id}`);
  return definePipelineCommand(pipeline, {
    description: `Run ${id} from the YAML document.`,
    params,
    mapOptions: ({ lines }) => ({ lines: lines.split(",") }),
    summarize: (result) => [JSON.stringify(result)],
  });
}

export const YamlImportCommand = command("yaml-import");
export const YamlPreviewCommand = command("yaml-preview");
