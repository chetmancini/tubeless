import { parseArgs } from "node:util";
import type { PipelineRunControls } from "./pipeline.js";
import { renderPipelinePlan } from "./render.js";
import {
  errorMessage,
  loadPlanSource,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const PLAN_USAGE = `Usage: tubeless plan [options] <pipeline-or-command-file>

Preview pipeline selection without running steps or requiring domain options.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
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
      step: { type: "string", short: "s", multiple: true },
      target: { type: "string", short: "t", multiple: true },
    },
    strict: true,
  });
}

export async function runPlan(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  let parsed: ReturnType<typeof parsePlanArgs>;
  try {
    parsed = parsePlanArgs(argv);
  } catch (error) {
    return writeUsageError(io, errorMessage(error), PLAN_USAGE);
  }

  if (parsed.values.help) {
    io.stdout.write(PLAN_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (parsed.positionals.length !== 1) {
    return writeUsageError(io, "Pass exactly one pipeline or command file.", PLAN_USAGE);
  }

  const loaded = await loadPlanSource(parsed.positionals[0]!, parsed.values.export, io);
  if ("exitCode" in loaded) return loaded.exitCode;

  const controls: PipelineRunControls = {
    dryRun: parsed.values["dry-run"] ?? false,
  };
  if (parsed.values.step !== undefined) controls.stepIds = parsed.values.step;
  if (parsed.values.target !== undefined) controls.targets = parsed.values.target;
  const view = loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline;
  const plan = view.plan(controls);
  const rendered = parsed.values.json
    ? renderPipelinePlan(plan, { format: "json", pretty: true })
    : renderPipelinePlan(plan, { explain: parsed.values.explain ?? false });
  io.stdout.write(`${rendered}\n`);
  return plan.ok ? TUBELESS_WORKBENCH_EXIT_CODE.success : TUBELESS_WORKBENCH_EXIT_CODE.planning;
}
