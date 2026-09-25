import type { PipelineContext } from "../core/pipeline.js";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import { isAbortError } from "../utilities/abort.js";
import { renderPipelineError } from "../render/render.js";
import {
  isCliHelpRequested,
  isCliValidationError,
  isPipelineExecutionError,
  toExitCode,
} from "../cli/cli-exit.js";
import {
  commandContext,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

export async function executePipelineCommand(
  command: Pick<WorkbenchPipelineCommand, "run">,
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
  command: Pick<WorkbenchPipelineCommand, "execute">,
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
