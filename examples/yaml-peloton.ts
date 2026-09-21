import { defineProject } from "tubeless/project";
import { definePipelineCommand } from "tubeless/cli";
import document from "./declarative/peloton.yaml";
import { pelotonRegistry } from "./declarative/peloton-handlers.ts";

const pipeline = defineProject("yaml-peloton", document, pelotonRegistry).get("yaml-peloton");
export const YamlPelotonPipeline = pipeline;

export const YamlPelotonCommand = definePipelineCommand(YamlPelotonPipeline, {
  name: "Peloton from YAML",
  description:
    "YAML road-race demo: progress, concurrent inspections, retries, dry runs, and failure gates. All I/O is simulated.",
  params: {
    delay: {
      type: "number",
      optional: true,
      integer: true,
      min: 0,
      max: 2000,
      description: "Milliseconds per progress tick (default 300).",
    },
    concurrency: {
      type: "number",
      optional: true,
      integer: true,
      min: 1,
      max: 8,
      description: "Concurrent bike inspections (default 2).",
    },
    "fail-audit": {
      type: "boolean",
      description: "Fail the independent team-car audit; try with --continue-on-error.",
    },
    "fail-tech": { type: "boolean", description: "Fail tech validation and block publication." },
  },
  mapOptions: (args) => ({
    delay: args.delay ?? 300,
    concurrency: args.concurrency ?? 2,
    failAudit: args["fail-audit"],
    failTech: args["fail-tech"],
  }),
  summarize: (result) => [JSON.stringify(result)],
});

// bun examples/yaml-peloton.ts --delay 200
// bun examples/yaml-peloton.ts --dry-run
if (import.meta.main) {
  void YamlPelotonCommand.main();
}
