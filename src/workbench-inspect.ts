import { parseArgs } from "node:util";
import { renderPipelinePlan } from "./render.js";
import {
  loadPlanSource,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const INSPECT_USAGE = `Usage: tubeless inspect [options] <pipeline-or-command-file>

Show pipeline identity plus the default structural plan.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
      --json            Emit identity and the default plan as JSON
  -h, --help            Show this help
`;

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function parseInspectArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      export: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    strict: true,
  });
}

export async function runInspect(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: INSPECT_USAGE,
      parse: parseInspectArgs,
      helpRequested: (parsed) => parsed.values.help === true,
      positionals: (parsed) => parsed.positionals,
      positionalCountError: {
        count: 1,
        message: "Pass exactly one pipeline or command file.",
      },
      async run(parsed, commandIo) {
        const loaded = await loadPlanSource(
          parsed.positionals[0]!,
          parsed.values.export,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        const view =
          loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline;
        const plan = view.plan();
        if (parsed.values.json) {
          commandIo.stdout.write(
            `${JSON.stringify(
              {
                pipelineId: view.id,
                targetIds: [...view.targetIds],
                stepIds: [...view.stepIds],
                plan,
              },
              null,
              2
            )}\n`
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        commandIo.stdout.write(
          [
            `Pipeline ${view.id}`,
            `Targets: ${list(view.targetIds)}`,
            `Exact steps: ${list(view.stepIds)}`,
            renderPipelinePlan(plan, { explain: false }),
            "",
          ].join("\n")
        );
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
