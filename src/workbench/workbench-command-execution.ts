import { CliHelpRequested, CliValidationError } from "../cli/cli.js";
import { throwIfAborted } from "../utilities/abort.js";
import type { PipelineContext } from "../core/pipeline.js";
import {
  executeHostedCommandOperation,
  hostedCommandContext,
} from "../hosting/hosting-commands.js";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import type { WorkbenchCliIo } from "./workbench-shared.js";

export async function executePipelineCommand(
  command: Pick<WorkbenchPipelineCommand, "parse" | "execute">,
  args: readonly string[],
  io: WorkbenchCliIo,
  signal: AbortSignal,
  prepareContext?: () => Promise<Omit<PipelineContext, "cwd" | "log" | "signal"> | undefined>
): Promise<number> {
  return executeHostedCommandOperation(
    async () => {
      const parsed = command.parse(args, hostedCommandContext(io, signal));
      if (parsed.kind === "help") throw new CliHelpRequested(parsed.helpText);
      if (parsed.kind === "error") throw new CliValidationError(parsed.errors, parsed.helpText);
      throwIfAborted(signal, "Run recording setup");
      let pipelineContext: Omit<PipelineContext, "cwd" | "log" | "signal"> | undefined;
      try {
        pipelineContext = await prepareContext?.();
      } catch (error) {
        throwIfAborted(signal, "Run recording setup");
        throw error;
      }
      await command.execute(parsed.values, hostedCommandContext(io, signal, pipelineContext));
    },
    io,
    signal
  );
}

/** Execute already validated structured command values through the normal workbench errors. */
export { executeHostedCommand as executePipelineCommandValues } from "../hosting/hosting-commands.js";
