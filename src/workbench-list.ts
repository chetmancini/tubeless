import { parseArgs } from "node:util";
import {
  DEFAULT_PIPELINE_PROJECT_MANIFEST,
  loadPipelineProjectManifest,
} from "./workbench-project-loader.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const LIST_USAGE = `Usage: tubeless list [options]

List explicitly registered commands from a Tubeless project manifest.

Options:
  -p, --project <path>  Project manifest (default: ./tubeless.project.ts)
      --json            Emit the versioned manifest inventory as JSON
  -h, --help            Show this help
`;

function parseListArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      project: { type: "string", short: "p" },
    },
    strict: true,
  });
}

export async function runList(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: LIST_USAGE,
      parse: parseListArgs,
      helpRequested: (parsed) => parsed.values.help === true,
      positionals: (parsed) => parsed.positionals,
      positionalCountError: { count: 0, message: "List does not accept a positional argument." },
      async run(parsed, commandIo) {
        const loaded = await loadPipelineProjectManifest(
          parsed.values.project ?? DEFAULT_PIPELINE_PROJECT_MANIFEST,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        if (parsed.values.json) {
          commandIo.stdout.write(
            `${JSON.stringify(
              {
                commands: loaded.manifest.commands,
                cwd: loaded.manifest.cwd ?? ".",
                manifest: loaded.filePath,
                version: loaded.manifest.version,
              },
              null,
              2
            )}\n`
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        for (const command of loaded.manifest.commands) {
          const selectedExport = command.export ? `#${command.export}` : "";
          const displayName = command.name ? `\t${command.name}` : "";
          commandIo.stdout.write(`${command.id}\t${command.file}${selectedExport}${displayName}\n`);
        }
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
