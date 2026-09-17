import { definePipelineCommand } from "tubeless/cli";
import { EnrichPipeline } from "../pipelines/enrich.ts";

export const EnrichCommand = definePipelineCommand(EnrichPipeline, {
  description: "Parse locally, rehearse a remote enrich, and skip remote charge on dry-run.",
  params: {
    lines: {
      type: "string",
      description: "Comma-separated rows to parse.",
    },
  },
  mapOptions: (args) => ({
    lines: String(args.lines)
      .split(",")
      .map((line) => line.trim()),
  }),
  summarize: (result) => [`Enriched ${result.rows.length} row(s).`],
});

if (import.meta.main) {
  void EnrichCommand.main();
}
