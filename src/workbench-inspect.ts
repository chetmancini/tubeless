import { parseArgs } from "node:util";
import type { PipelinePlan } from "./pipeline.js";
import { renderPipelinePlan } from "./render.js";
import { loadPlanSourceTarget } from "./workbench-project-loader.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const INSPECT_USAGE = `Usage: tubeless inspect [options] <pipeline-or-command-file>

Show a registered id or exported pipeline's identity plus the default structural plan.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
  -p, --project <path>  Resolve a registered id from this project manifest
      --json            Emit identity and the default plan as JSON
  -h, --help            Show this help
`;

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

interface WorkbenchInspection {
  commandId?: string;
  pipelineId: string;
  plan: PipelinePlan;
  stepIds: string[];
  targetIds: string[];
}

function parseInspectArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      export: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      project: { type: "string", short: "p" },
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
        const loaded = await loadPlanSourceTarget(
          parsed.positionals[0]!,
          parsed.values.export,
          parsed.values.project,
          commandIo,
          INSPECT_USAGE
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        const { view } = loaded;
        const plan = view.plan();
        if (parsed.values.json) {
          const inspection: WorkbenchInspection = {
            pipelineId: view.id,
            targetIds: [...view.targetIds],
            stepIds: [...view.stepIds],
            plan,
          };
          if (loaded.registration) inspection.commandId = loaded.registration.id;
          commandIo.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        commandIo.stdout.write(
          [
            ...(loaded.registration ? [`Command ${loaded.registration.id}`] : []),
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
