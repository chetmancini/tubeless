import { parseArgs } from "node:util";
import { renderPipelinePlan } from "./render.js";
import {
  errorMessage,
  loadPipeline,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const INSPECT_USAGE = `Usage: tubeless inspect [options] <pipeline-file>

Show pipeline identity plus the default structural plan.

Options:
  -e, --export <name>   Select a pipeline export when the file has more than one
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
  let parsed: ReturnType<typeof parseInspectArgs>;
  try {
    parsed = parseInspectArgs(argv);
  } catch (error) {
    return writeUsageError(io, errorMessage(error), INSPECT_USAGE);
  }

  if (parsed.values.help) {
    io.stdout.write(INSPECT_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (parsed.positionals.length !== 1) {
    return writeUsageError(io, "Pass exactly one pipeline file.", INSPECT_USAGE);
  }

  const loaded = await loadPipeline(parsed.positionals[0]!, parsed.values.export, io);
  if ("exitCode" in loaded) return loaded.exitCode;

  const plan = loaded.pipeline.plan({});
  if (parsed.values.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          pipelineId: loaded.pipeline.id,
          targetIds: [...loaded.pipeline.targetIds],
          stepIds: [...loaded.pipeline.stepIds],
          plan,
        },
        null,
        2
      )}\n`
    );
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }

  io.stdout.write(
    [
      `Pipeline ${loaded.pipeline.id}`,
      `Targets: ${list(loaded.pipeline.targetIds)}`,
      `Exact steps: ${list(loaded.pipeline.stepIds)}`,
      renderPipelinePlan(plan, { explain: false }),
      "",
    ].join("\n")
  );
  return TUBELESS_WORKBENCH_EXIT_CODE.success;
}
