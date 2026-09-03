import { parseArgs } from "node:util";
import type { PipelineMermaidDirection } from "./pipeline.js";
import {
  loadPlanSource,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const MERMAID_DIRECTIONS = ["BT", "LR", "RL", "TB", "TD"] as const;

function isMermaidDirection(value: string): value is PipelineMermaidDirection {
  // SAFETY: MERMAID_DIRECTIONS is a const tuple of exactly the PipelineMermaidDirection
  // union members, so membership implies the value is a valid direction.
  return (MERMAID_DIRECTIONS as readonly string[]).includes(value);
}

const GRAPH_USAGE = `Usage: tubeless graph [options] <pipeline-or-command-file>

Generate Mermaid flowchart source from an exported tubeless pipeline or command.

Options:
  -e, --export <name>       Select a pipeline or command export when the file has more than one
  -d, --direction <value>   Flowchart direction: BT, LR, RL, TB, or TD (default: TD)
      --descriptions        Include step descriptions in node labels
      --markdown            Wrap the result in a fenced Mermaid Markdown block
  -h, --help                Show this help
`;

function parseGraphArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      descriptions: { type: "boolean" },
      direction: { type: "string", short: "d" },
      export: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
      markdown: { type: "boolean" },
    },
    strict: true,
  });
}

export async function runGraph(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: GRAPH_USAGE,
      parse: parseGraphArgs,
      helpRequested: (parsed) => parsed.values.help === true,
      positionals: (parsed) => parsed.positionals,
      positionalCountError: {
        count: 1,
        message: "Pass exactly one pipeline or command file.",
      },
      async run(parsed, commandIo) {
        const direction = parsed.values.direction ?? "TD";
        if (!isMermaidDirection(direction)) {
          return writeUsageError(
            commandIo,
            `Invalid direction ${JSON.stringify(direction)}.`,
            GRAPH_USAGE
          );
        }

        const loaded = await loadPlanSource(
          parsed.positionals[0]!,
          parsed.values.export,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        const view =
          loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline;
        const source = view.toMermaid({
          direction,
          includeDescriptions: parsed.values.descriptions,
        });
        const terminatedSource = `${source.replace(/\n+$/, "")}\n`;
        commandIo.stdout.write(
          parsed.values.markdown ? `\`\`\`mermaid\n${terminatedSource}\`\`\`\n` : terminatedSource
        );
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
