import { runGraph } from "./workbench-graph.js";
import { runInspect } from "./workbench-inspect.js";
import { runPlan } from "./workbench-plan.js";
import { runCommand } from "./workbench-run.js";
import {
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runUi } from "./workbench-ui.js";

export { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";

const WORKBENCH_USAGE = `Usage: tubeless <command> [options] <pipeline-file>

Inspect, plan, visualize, or safely run exported tubeless workflows.

Commands:
  tubeless inspect   Show pipeline identity and the default structural plan
  tubeless plan      Preview step selection without executing the pipeline
  tubeless graph     Generate Mermaid flowchart source
  tubeless run       Execute an exported definePipelineCommand
  tubeless ui        Open the optional local run studio

Run tubeless <command> --help for command-specific options.
`;

/** Run the `tubeless` development workbench. Execution requires a definePipelineCommand export. */
export async function runWorkbenchCli(
  argv: readonly string[],
  io: WorkbenchCliIo
): Promise<number> {
  const [command, ...commandArgs] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(WORKBENCH_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (command === undefined) {
    return writeUsageError(io, "Pass a command.", WORKBENCH_USAGE);
  }
  if (command === "inspect") return runInspect(commandArgs, io);
  if (command === "plan") return runPlan(commandArgs, io);
  if (command === "graph") return runGraph(commandArgs, io);
  if (command === "run") return runCommand(commandArgs, io);
  if (command === "ui") return runUi(commandArgs, io);
  return writeUsageError(io, `Unknown command ${JSON.stringify(command)}.`, WORKBENCH_USAGE);
}
