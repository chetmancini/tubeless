import { parseArgs } from "node:util";
import type { PipelineRunControls } from "./pipeline.js";
import { renderPipelinePlan } from "./render.js";
import { loadPlanSourceTarget } from "./workbench-project-loader.js";
import {
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const PLAN_USAGE = `Usage: tubeless plan [options] <pipeline-or-command-file>

Preview a registered or exported pipeline without running steps or requiring domain options.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
  -p, --project <path>  Resolve a registered id from this project manifest
  -t, --target <id>     Select a declared target and its prerequisites (repeatable)
  -s, --step <id>       Select exact internal steps (repeatable)
      --dry-run         Show each step's dry-run disposition
      --explain         Include target/dependency selection provenance
      --json            Emit the complete structured plan as JSON
  -h, --help            Show this help
`;

function parsePlanArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      explain: { type: "boolean" },
      export: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      project: { type: "string", short: "p" },
      step: { type: "string", short: "s", multiple: true },
      target: { type: "string", short: "t", multiple: true },
    },
    strict: true,
  });
}

export async function runPlan(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: PLAN_USAGE,
      parse: parsePlanArgs,
      helpRequested: (parsed) => parsed.values.help === true,
      positionals: (parsed) => parsed.positionals,
      positionalCountError: {
        count: 1,
        message: "Pass exactly one pipeline or command file.",
      },
      async run(parsed, commandIo) {
        if (parsed.values.export !== undefined && parsed.values.project !== undefined) {
          return writeUsageError(
            commandIo,
            "--export cannot be combined with --project; the manifest owns export selection.",
            PLAN_USAGE
          );
        }
        const loaded = await loadPlanSourceTarget(
          parsed.positionals[0]!,
          parsed.values.export,
          parsed.values.project,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        const controls: PipelineRunControls = {
          dryRun: parsed.values["dry-run"] ?? false,
        };
        if (parsed.values.step !== undefined) controls.stepIds = parsed.values.step;
        if (parsed.values.target !== undefined) controls.targets = parsed.values.target;
        const view =
          loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline;
        const plan = view.plan(controls);
        const rendered = parsed.values.json
          ? renderPipelinePlan(plan, { format: "json", pretty: true })
          : renderPipelinePlan(plan, { explain: parsed.values.explain ?? false });
        commandIo.stdout.write(`${rendered}\n`);
        return plan.ok
          ? TUBELESS_WORKBENCH_EXIT_CODE.success
          : TUBELESS_WORKBENCH_EXIT_CODE.planning;
      },
    },
    argv,
    io
  );
}
