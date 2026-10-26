import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { upgradeSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import {
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const UPGRADE_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.upgrade);

function parseUpgradeArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, WORKBENCH_SPECS.upgrade.options);
}

/** Confirm and apply a SQLite run-store schema upgrade. */
export async function runUpgrade(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.upgrade,
      parse: parseUpgradeArgs,
      async run(parsed, commandIo) {
        if (parsed.positionals.length > 0) {
          return writeUsageError(
            commandIo,
            "upgrade does not take a positional argument.",
            UPGRADE_USAGE
          );
        }
        const filename = path.resolve(
          commandIo.cwd,
          parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE
        );
        try {
          await stat(filename);
        } catch {
          commandIo.stderr.write(`Error: Run store not found at ${filename}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }
        if (parsed.values.yes !== true) {
          return writeUsageError(
            commandIo,
            `Refusing to upgrade ${filename}. This rewrites the history file in place and cannot be undone. Pass --yes to continue.`,
            UPGRADE_USAGE
          );
        }
        try {
          const result = await upgradeSqlitePipelineRunStore(filename);
          const message =
            result.from === result.to
              ? `${filename} is already schema version ${result.to}.\n`
              : `Upgraded ${filename} from schema version ${result.from} to ${result.to}.\n`;
          await writeCliChunk(commandIo.stdout, message);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }
      },
    },
    argv,
    io
  );
}
