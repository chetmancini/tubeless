import * as fs from "node:fs";
import { definePipelineCommand } from "tubeless/cli";
import { PublishPipeline } from "../pipelines/publish.ts";

export const PublishCommand = definePipelineCommand(PublishPipeline, {
  description: "Validate and publish a source artifact.",
  params: {
    source: {
      type: "path",
      description: "File whose contents become the published artifact.",
      kind: "file",
      mustExist: true,
    },
  },
  mapOptions: (args) => ({
    source: fs.readFileSync(args.source, "utf8"),
  }),
  summarize: (result) =>
    result.publishedId === undefined
      ? ["Dry run or unpublished artifact."]
      : [`Published ${result.publishedId}.`],
});

if (import.meta.main) {
  void PublishCommand.main();
}
