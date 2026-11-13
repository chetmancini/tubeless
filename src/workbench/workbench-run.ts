import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";
import {
  openWorkbenchRecording,
  recordingDestinationsConflict,
  type WorkbenchRecording,
} from "./workbench-recording.js";
import { createLaunchTracing, type LaunchTracing } from "../hosting/launch-tracing.js";
import { toExitCode } from "../cli/cli-exit.js";
import { CliHelpRequested, CliValidationError } from "../cli/cli.js";
import type { PipelineContext, PipelineRun } from "../core/pipeline.js";
import { serializeRunJson } from "./workbench-run-json.js";
import {
  executeHostedCommandOperation,
  hostedCommandContext,
} from "../hosting/hosting-commands.js";
import { throwIfAborted } from "../utilities/abort.js";
import { resolveWorkbenchRegistration } from "./workbench-project-loader.js";
import {
  errorMessage,
  manageWorkbenchSignal,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const RUN_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.run);

/** Shared with the executable so stdout routing uses the same workbench argument boundary. */
export function parseRunArgs(argv: readonly string[]) {
  const separatorIndex = argv.indexOf("--");
  const workbenchArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const commandArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  return {
    ...parseSubcommandArgs(workbenchArgs, WORKBENCH_SPECS.run.options),
    commandArgs,
  };
}

export async function runCommand(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.run,
      parse: parseRunArgs,
      positionalCountError: { count: 1, message: "Pass exactly one pipeline ID or file." },
      run: executeRun,
    },
    argv,
    io
  );
}

async function executeRun(
  parsed: ReturnType<typeof parseRunArgs>,
  io: WorkbenchCliIo
): Promise<number> {
  if (parsed.values.json && parsed.values.trace === "-") {
    return writeUsageError(io, "--json cannot be combined with --trace -.", RUN_USAGE);
  }
  const registration = await resolveWorkbenchRegistration(
    parsed.positionals[0]!,
    parsed.values.export,
    parsed.values.project,
    io,
    RUN_USAGE
  );
  if ("exitCode" in registration) return registration.exitCode;
  const loaded = await registration.loadCommand(io);
  if ("exitCode" in loaded) return loaded.exitCode;

  const destinations = { store: parsed.values.store, trace: parsed.values.trace };
  if (await recordingDestinationsConflict(destinations, io.cwd)) {
    return writeUsageError(io, "--store and --trace cannot write to the same path.", RUN_USAGE);
  }

  let managedSignal: ReturnType<typeof manageWorkbenchSignal> | undefined;
  let recording: WorkbenchRecording | undefined;
  let launchTracing: LaunchTracing | undefined;
  let completedRun: PipelineRun | undefined;
  let exitCode: number = TUBELESS_WORKBENCH_EXIT_CODE.execution;
  try {
    managedSignal = manageWorkbenchSignal(io);
    const signal = managedSignal.signal;
    const commandIo =
      parsed.values.json || parsed.values.trace === "-"
        ? { ...loaded.commandIo, stdout: loaded.commandIo.stderr }
        : loaded.commandIo;
    exitCode = await executeHostedCommandOperation(
      async () => {
        const input = loaded.command.parse(
          parsed.commandArgs,
          hostedCommandContext(commandIo, signal)
        );
        if (input.kind === "help") throw new CliHelpRequested(input.helpText);
        if (input.kind === "error") throw new CliValidationError(input.errors, input.helpText);
        throwIfAborted(signal, "Run recording setup");
        let pipelineContext: Omit<PipelineContext, "cwd" | "log" | "signal">;
        try {
          recording = await openWorkbenchRecording(destinations, io, signal);
          launchTracing = createLaunchTracing({
            context: { pipelineId: loaded.command.id, cwd: commandIo.cwd, signal },
            configurations: [registration.tracing],
            exporters: recording.exporters,
          });
          pipelineContext = {
            hooks: parsed.values.json
              ? {
                  onPipelineComplete: (run: PipelineRun) => {
                    completedRun = run;
                  },
                }
              : undefined,
            tracing: launchTracing.prepare(),
          };
        } catch (error) {
          throwIfAborted(signal, "Run recording setup");
          throw error;
        }
        await loaded.command.execute(
          input.values,
          hostedCommandContext(commandIo, signal, pipelineContext)
        );
      },
      commandIo,
      signal
    );
    if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success && managedSignal.wasInterrupted()) {
      exitCode = TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    const interrupted = managedSignal?.wasInterrupted() ?? io.signal?.aborted === true;
    exitCode = interrupted ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation : toExitCode(error);
  } finally {
    await launchTracing?.close();
    for (const error of (await recording?.close()) ?? []) {
      io.stderr.write(`Error: ${errorMessage(error)}\n`);
      if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
    }
    managedSignal?.cleanup();
  }
  if (parsed.values.json && completedRun) {
    try {
      // A cancelled run still has a report: do not pass its aborted execution signal.
      await writeCliChunk(io.stdout, serializeRunJson(completedRun));
    } catch (error) {
      io.stderr.write(`Error: ${errorMessage(error)}\n`);
      if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
    }
  }
  return exitCode;
}
