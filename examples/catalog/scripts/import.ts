import * as fs from "node:fs";
import { definePipelineCommand } from "tubeless/cli";
import { ImportPipeline } from "../pipelines/import.ts";

export const ImportCommand = definePipelineCommand(ImportPipeline, {
  description: "Normalize a newline-delimited list of input rows.",
  params: {
    source: {
      type: "path",
      description: "File with one row per line.",
      kind: "file",
      mustExist: true,
    },
  },
  mapOptions: (args) => ({
    lines: fs.readFileSync(args.source, "utf8").split("\n"),
  }),
  summarize: (result) => [`Normalized ${result.count} row(s).`],
});

if (import.meta.main) {
  void ImportCommand.main();
}
