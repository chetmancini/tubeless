import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
import { didYouMean } from "../utilities/suggest.js";
import { runGraph, runInspect, runList, runPlan, runValidate } from "./workbench-commands.js";
import { runComplete, runCompletion } from "./workbench-completion.js";
import { runHistory } from "./workbench-history.js";
import { runCommand } from "./workbench-run.js";
import { runUpgrade } from "./workbench-upgrade.js";
import {
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runUi } from "./workbench-ui.js";

export { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";

type WorkbenchCommandHandler = (argv: readonly string[], io: WorkbenchCliIo) => Promise<number>;

const WORKBENCH_HANDLERS = {
  list: runList,
  validate: runValidate,
  inspect: runInspect,
  plan: runPlan,
  graph: runGraph,
  run: runCommand,
  history: runHistory,
  upgrade: runUpgrade,
  agent: async (argv, io) => (await import("./agent/command.js")).runAgent(argv, io),
  init: async (argv, io) => (await import("./workbench-init.js")).runInit(argv, io),
  auth: async (argv, io) => (await import("./cloud/auth.js")).runAuth(argv, io),
  cloud: async (argv, io) => (await import("./cloud/command.js")).runCloud(argv, io),
  ui: runUi,
  completion: runCompletion,
} satisfies Record<keyof typeof WORKBENCH_SPECS, WorkbenchCommandHandler>;

/** Public subcommands in usage order; dispatch, typo suggestions, and completion share it. */
const WORKBENCH_COMMANDS = Object.values(WORKBENCH_SPECS).map((spec) => ({
  name: spec.name,
  description: spec.description,
  spec,
  run: WORKBENCH_HANDLERS[spec.name],
}));

const WORKBENCH_USAGE = `Usage: tubeless <command> [options] <registered-id|pipeline-or-command-file>

Inspect, plan, visualize, or safely run exported tubeless workflows.

Commands:
${WORKBENCH_COMMANDS.map(({ name, description }) => `  tubeless ${name.padEnd(10)}  ${description}\n`).join("")}
Run tubeless <command> --help for command-specific options.
`;

/** Run the `tubeless` development workbench. */
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
  // Hidden protocol command behind the generated shell completion scripts.
  if (command === "__complete") return runComplete(commandArgs, io, WORKBENCH_COMMANDS);
  const entry = WORKBENCH_COMMANDS.find(({ name }) => name === command);
  if (entry) return entry.run(commandArgs, io);
  const suggestion = didYouMean(command, [...WORKBENCH_COMMANDS.map(({ name }) => name), "help"]);
  return writeUsageError(
    io,
    suggestion === undefined
      ? `Unknown command ${JSON.stringify(command)}.`
      : `Unknown command ${JSON.stringify(command)}. ${suggestion}`,
    WORKBENCH_USAGE
  );
}
