import * as path from "node:path";
import { parseArgs } from "node:util";
import { isAbortError } from "./abort.js";
import type { CliContext } from "./cli.js";
import type { PipelineContext } from "./pipeline.js";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import { renderPipelineError } from "./render.js";
import type { PipelineRunEventStore } from "./run-store.js";
import {
  commandContext,
  errorMessage,
  isCliHelpRequested,
  isCliValidationError,
  isPipelineExecutionError,
  loadPipelineCommand,
  manageWorkbenchSignal,
  TUBELESS_WORKBENCH_EXIT_CODE,
  toExitCode,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

export interface WorkbenchStructuredPipelineCommand extends WorkbenchPipelineCommand {
  execute(values: Record<string, unknown>, context?: Partial<CliContext>): Promise<unknown>;
  parseValues(
    values: Record<string, unknown>,
    context?: Partial<CliContext>
  ): ReturnType<WorkbenchPipelineCommand["parse"]>;
}

const RUN_USAGE = `Usage: tubeless run [options] <command-file> [-- <command-args...>]

Execute an exported definePipelineCommand using its own validated CLI contract.

Options:
  -e, --export <name>   Select a command export when the file has more than one
      --store <path>    Append run events to a local SQLite database
  -h, --help            Show this workbench help

Pass application flags after --. For command help, use: tubeless run <file> -- --help
`;

function parseRunArgs(argv: readonly string[]) {
  const separatorIndex = argv.indexOf("--");
  const workbenchArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const commandArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  return {
    commandArgs,
    parsed: parseArgs({
      args: [...workbenchArgs],
      allowPositionals: true,
      options: {
        export: { type: "string", short: "e" },
        help: { type: "boolean", short: "h" },
        store: { type: "string" },
      },
      strict: true,
    }),
  };
}

export async function executePipelineCommand(
  command: WorkbenchPipelineCommand,
  args: readonly string[],
  io: WorkbenchCliIo,
  signal: AbortSignal,
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">
): Promise<number> {
  return executePipelineCommandOperation(
    async () => {
      await command.run(args, commandContext(io, signal, pipelineContext));
    },
    io,
    signal
  );
}

/** Execute already validated structured command values through the normal workbench errors. */
export async function executePipelineCommandValues(
  command: WorkbenchStructuredPipelineCommand,
  values: Record<string, unknown>,
  io: WorkbenchCliIo,
  signal: AbortSignal,
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">
): Promise<number> {
  return executePipelineCommandOperation(
    async () => {
      await command.execute(values, commandContext(io, signal, pipelineContext));
    },
    io,
    signal
  );
}

async function executePipelineCommandOperation(
  operation: () => Promise<void>,
  io: WorkbenchCliIo,
  signal: AbortSignal
): Promise<number> {
  try {
    await operation();
    return signal.aborted
      ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation
      : TUBELESS_WORKBENCH_EXIT_CODE.success;
  } catch (error) {
    if (isCliHelpRequested(error)) {
      io.stdout.write(`${error.helpText.replace(/\n+$/, "")}\n`);
      return toExitCode(error);
    }
    if (isCliValidationError(error)) {
      for (const validationError of error.errors) {
        io.stderr.write(`Error: ${validationError}\n`);
      }
      io.stderr.write(`\n${error.helpText.replace(/\n+$/, "")}\n`);
      return toExitCode(error);
    }
    if (isPipelineExecutionError(error)) {
      for (const pipelineError of error.result.errors) {
        io.stderr.write(`Error: ${renderPipelineError(pipelineError)}\n`);
      }
      return toExitCode(error);
    }
    if (signal.aborted && isAbortError(error)) {
      return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return toExitCode(error);
  }
}

export async function runCommand(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  let parsed: ReturnType<typeof parseRunArgs>;
  try {
    parsed = parseRunArgs(argv);
  } catch (error) {
    return writeUsageError(
      io,
      `${errorMessage(error)} Application flags belong after --.`,
      RUN_USAGE
    );
  }

  if (parsed.parsed.values.help) {
    io.stdout.write(RUN_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (parsed.parsed.positionals.length !== 1) {
    return writeUsageError(io, "Pass exactly one pipeline command file.", RUN_USAGE);
  }

  const loaded = await loadPipelineCommand(
    parsed.parsed.positionals[0]!,
    parsed.parsed.values.export,
    io
  );
  if ("exitCode" in loaded) return loaded.exitCode;

  const managedSignal = manageWorkbenchSignal(io);
  let store: PipelineRunEventStore | undefined;
  try {
    let pipelineContext: Omit<PipelineContext, "cwd" | "log" | "signal"> | undefined;
    if (parsed.parsed.values.store) {
      const { openSqlitePipelineRunStore } = await import("./run-store-sqlite.js");
      store = await openSqlitePipelineRunStore(path.resolve(io.cwd, parsed.parsed.values.store));
      pipelineContext = { tracing: { exporter: store } };
    }
    const exitCode = await executePipelineCommand(
      loaded.command,
      parsed.commandArgs,
      io,
      managedSignal.signal,
      pipelineContext
    );
    return exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success && managedSignal.wasInterrupted()
      ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation
      : exitCode;
  } finally {
    await store?.close();
    managedSignal.cleanup();
  }
}
