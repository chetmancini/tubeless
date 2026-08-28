import { parseArgs } from "node:util";
import type { PipelineMermaidDirection } from "./pipeline.js";
import {
  errorMessage,
  loadPlanSource,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

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
  let parsed: ReturnType<typeof parseGraphArgs>;
  try {
    parsed = parseGraphArgs(argv);
  } catch (error) {
    return writeUsageError(io, errorMessage(error), GRAPH_USAGE);
  }

  if (parsed.values.help) {
    io.stdout.write(GRAPH_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (parsed.positionals.length !== 1) {
    return writeUsageError(io, "Pass exactly one pipeline or command file.", GRAPH_USAGE);
  }

  const direction = parsed.values.direction ?? "TD";
  if (!isMermaidDirection(direction)) {
    return writeUsageError(io, `Invalid direction ${JSON.stringify(direction)}.`, GRAPH_USAGE);
  }

  const loaded = await loadPlanSource(parsed.positionals[0]!, parsed.values.export, io);
  if ("exitCode" in loaded) return loaded.exitCode;

  const view = loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline;
  const source = view.toMermaid({
    direction,
    includeDescriptions: parsed.values.descriptions,
  });
  const terminatedSource = `${source.replace(/\n+$/, "")}\n`;
  io.stdout.write(
    parsed.values.markdown ? `\`\`\`mermaid\n${terminatedSource}\`\`\`\n` : terminatedSource
  );
  return TUBELESS_WORKBENCH_EXIT_CODE.success;
}
