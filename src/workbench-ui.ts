import { stat } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  importModuleNamespace,
  selectUniqueExport,
  type WorkbenchPipelineCommand,
} from "./pipeline-module.js";
import { createRunId } from "./pipeline.js";
import type { PipelineStudioConfig } from "./workbench-studio.js";
import type { PipelineRunEventStore } from "./run-store.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchResult,
  PipelineRunStudioLauncher,
} from "./run-store-ui.js";
import { executePipelineCommandValues } from "./workbench-run.js";
import {
  commandContext,
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  loadPipelineCommand,
  onFirstProcessSignal,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const UI_USAGE = `Usage: tubeless ui [options] [studio-file]

Serve the local pipeline studio from an append-only SQLite run store. Register
definePipelineCommand modules directly or through one studio config file.

Options:
      --command <path> Register a launchable pipeline command (repeatable)
  -e, --export <name>  Select the export when registering exactly one command
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
      --host <value>    Bind address (default: 127.0.0.1)
      --port <number>   HTTP port (default: 4317)
  -h, --help            Show this help
`;

/** Resolve a studio launch only after the run store has the run, or after a silent exit. */
async function acknowledgeRecordedLaunch(
  store: PipelineRunEventStore,
  runId: string,
  execution: Promise<number>,
  stopping: Promise<void>
): Promise<PipelineRunStudioLaunchResult> {
  let exitCode: number | undefined;
  let stopped = false;
  const settled = execution.then((code) => {
    exitCode = code;
    return code;
  });
  const stoppedOnce = stopping.then(() => {
    stopped = true;
  });
  while (exitCode === undefined && !stopped) {
    const events = await store.listEvents({ runId, limit: 1 });
    if (events.length > 0) return { accepted: true, runId };
    await Promise.race([
      settled,
      stoppedOnce,
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
    ]);
  }
  const events = await store.listEvents({ runId, limit: 1 });
  if (events.length > 0) return { accepted: true, runId };
  if (stopped) {
    return { accepted: false, errors: ["The local studio is stopping."] };
  }
  return {
    accepted: false,
    errors: [`Pipeline command exited (${exitCode}) before recording a run.`],
  };
}

function parseUiArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      command: { type: "string", multiple: true },
      export: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      port: { type: "string" },
      store: { type: "string" },
    },
    strict: true,
  });
}

/** A registered launchable command module: its file plus optional export/name. */
interface StudioCommandSpec {
  cwd: string;
  exportName?: string;
  filePath: string;
  name?: string;
}

async function loadPipelineStudioConfig(
  fileArgument: string,
  io: WorkbenchCliIo
): Promise<
  | { config: PipelineStudioConfig; filePath: string }
  | { exitCode: typeof TUBELESS_WORKBENCH_EXIT_CODE.load }
> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    const [{ isPipelineStudioConfig }, moduleExports] = await Promise.all([
      import("./workbench-studio.js"),
      importModuleNamespace(filePath),
    ]);
    return {
      config: selectUniqueExport(
        moduleExports,
        undefined,
        isPipelineStudioConfig,
        "studio config",
        { hintExport: false }
      ),
      filePath,
    };
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
}

export async function runUi(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  let parsed: ReturnType<typeof parseUiArgs>;
  try {
    parsed = parseUiArgs(argv);
  } catch (error) {
    return writeUsageError(io, errorMessage(error), UI_USAGE);
  }
  if (parsed.values.help) {
    io.stdout.write(UI_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (parsed.positionals.length > 1) {
    return writeUsageError(io, "Pass at most one studio config file.", UI_USAGE);
  }
  const directCommandFiles = parsed.values.command ?? [];
  const studioFile = parsed.positionals[0];
  if (parsed.values.export && (directCommandFiles.length !== 1 || studioFile)) {
    return writeUsageError(io, "--export requires exactly one registered --command.", UI_USAGE);
  }
  const port = Number(parsed.values.port ?? "4317");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return writeUsageError(io, "--port must be an integer from 0 to 65535.", UI_USAGE);
  }

  const specs: StudioCommandSpec[] = directCommandFiles.map((file) => {
    const spec: StudioCommandSpec = {
      cwd: io.cwd,
      filePath: path.resolve(io.cwd, file),
    };
    if (parsed.values.export !== undefined) {
      spec.exportName = parsed.values.export;
    }
    return spec;
  });
  if (studioFile) {
    const loadedConfig = await loadPipelineStudioConfig(studioFile, io);
    if ("exitCode" in loadedConfig) return loadedConfig.exitCode;
    const configDirectory = path.dirname(loadedConfig.filePath);
    const configCwd = path.resolve(configDirectory, loadedConfig.config.cwd ?? ".");
    specs.push(
      ...loadedConfig.config.commands.map((command) => {
        const spec: StudioCommandSpec = {
          cwd: configCwd,
          filePath: path.resolve(configDirectory, command.file),
        };
        if (command.export !== undefined) {
          spec.exportName = command.export;
        }
        if (command.name !== undefined) {
          spec.name = command.name;
        }
        return spec;
      })
    );
  }
  const identities = new Set<string>();
  for (const spec of specs) {
    const identity = `${spec.filePath}\0${spec.exportName ?? ""}`;
    if (identities.has(identity)) {
      return writeUsageError(
        io,
        `Command module ${JSON.stringify(spec.filePath)} is duplicated.`,
        UI_USAGE
      );
    }
    identities.add(identity);
  }

  const host = (parsed.values.host ?? "127.0.0.1").toLowerCase();
  const isLoopbackHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (specs.length > 0 && !isLoopbackHost) {
    return writeUsageError(io, "Browser-triggered execution requires a loopback --host.", UI_USAGE);
  }

  const studioStopController = new AbortController();
  const launchControllers = new Map<string, AbortController>();
  const activeLaunches = new Set<Promise<number>>();
  let markStudioStopping = (): void => undefined;
  const studioStopping = new Promise<void>((resolve) => {
    markStudioStopping = resolve;
  });
  const registrations: {
    command: WorkbenchPipelineCommand;
    commandIo: WorkbenchCliIo;
    descriptor: PipelineRunStudioCommand;
    runIdPrefix: string;
  }[] = [];
  for (const spec of specs) {
    const commandIo = { ...io, cwd: spec.cwd };
    const loaded = await loadPipelineCommand(spec.filePath, spec.exportName, commandIo);
    if ("exitCode" in loaded) return loaded.exitCode;
    const commandName = spec.name ?? loaded.command.descriptor.name;
    const descriptor: PipelineRunStudioCommand = {
      canPlan: true,
      id: `${spec.filePath}#${loaded.exportName}`,
      name: commandName,
      parameters: loaded.command.descriptor.parameters,
    };
    if (loaded.command.descriptor.description !== undefined) {
      descriptor.description = loaded.command.descriptor.description;
    }
    registrations.push({
      command: loaded.command,
      commandIo,
      descriptor,
      runIdPrefix: loaded.command.descriptor.name,
    });
  }

  const filename = path.resolve(io.cwd, parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE);
  let store:
    | Awaited<ReturnType<typeof import("./run-store-sqlite.js").openSqlitePipelineRunStore>>
    | undefined;
  let server:
    | Awaited<ReturnType<typeof import("./run-store-ui.js").startPipelineRunStudio>>
    | undefined;
  let disposeProcessSignals: (() => void) | undefined;
  try {
    const { openSqlitePipelineRunStore } = await import("./run-store-sqlite.js");
    const { startPipelineRunStudio } = await import("./run-store-ui.js");
    store = await openSqlitePipelineRunStore(filename);
    const commandById = new Map(
      registrations.map((registration) => [registration.descriptor.id, registration] as const)
    );
    const launcher: PipelineRunStudioLauncher | undefined =
      registrations.length === 0
        ? undefined
        : {
            commands: registrations.map(({ descriptor }) => descriptor),
            plan(commandId, input) {
              const registration = commandById.get(commandId);
              if (!registration?.command.plan) {
                throw new Error("Pipeline planning is not available for this command.");
              }
              return registration.command.plan(input);
            },
            async launch(commandId, values) {
              const registration = commandById.get(commandId);
              if (!registration)
                return { accepted: false, errors: ["Pipeline command not found."] };
              const runId = createRunId(registration.runIdPrefix);
              const pipelineContext = { runId, tracing: { exporter: store! } };
              const runController = new AbortController();
              const signal = AbortSignal.any([studioStopController.signal, runController.signal]);
              launchControllers.set(runId, runController);
              let parsedCommand: ReturnType<WorkbenchPipelineCommand["parseValues"]>;
              try {
                parsedCommand = registration.command.parseValues(
                  values,
                  commandContext(registration.commandIo, signal, pipelineContext)
                );
              } catch (error) {
                launchControllers.delete(runId);
                return { accepted: false, errors: [errorMessage(error)] };
              }
              if (parsedCommand.kind === "error") {
                launchControllers.delete(runId);
                return { accepted: false, errors: parsedCommand.errors };
              }
              if (parsedCommand.kind === "help") {
                launchControllers.delete(runId);
                return { accepted: false, errors: ["Help is not a launchable value set."] };
              }
              const execution = executePipelineCommandValues(
                registration.command,
                parsedCommand.values,
                registration.commandIo,
                signal,
                pipelineContext
              );
              activeLaunches.add(execution);
              void execution.finally(() => {
                activeLaunches.delete(execution);
                launchControllers.delete(runId);
              });
              return await acknowledgeRecordedLaunch(store!, runId, execution, studioStopping);
            },
            cancel(runId) {
              const controller = launchControllers.get(runId);
              if (!controller) return { cancelled: false };
              controller.abort(new DOMException("The run was cancelled.", "AbortError"));
              return { cancelled: true, runId };
            },
            liveRunIds() {
              return [...launchControllers.keys()];
            },
          };
    const studioOptions: Parameters<typeof startPipelineRunStudio>[0] = {
      host,
      launcher,
      port,
      store,
    };
    if (isLoopbackHost) {
      studioOptions.history = {
        clear: () => store!.clearHistory(),
        isBusy: () => activeLaunches.size > 0,
      };
    }
    server = await startPipelineRunStudio(studioOptions);
    io.stdout.write(`Tubeless local studio: ${server.url}\n`);
    io.stdout.write(`Run store: ${filename}\n`);
    if (registrations.length > 0) {
      io.stdout.write(
        `Launchable commands: ${registrations.map(({ descriptor }) => descriptor.name).join(", ")}\n`
      );
    }
    io.stdout.write("Press Ctrl-C to stop.\n");

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        markStudioStopping();
        resolve();
      };
      if (io.signal?.aborted) {
        stop();
        return;
      }
      if (io.signal) {
        io.signal.addEventListener("abort", stop, { once: true });
        return;
      }
      // Same de-dup pattern as `manageWorkbenchSignal`: the trampoline's
      // forwarded copy of a terminal Ctrl-C must not fall through to
      // default termination while the server, launches, and store close.
      disposeProcessSignals = onFirstProcessSignal(["SIGINT", "SIGTERM"], () => stop());
    });
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.execution;
  } finally {
    markStudioStopping();
    studioStopController.abort(new DOMException("The local studio is stopping.", "AbortError"));
    await server?.close();
    await Promise.allSettled(activeLaunches);
    await store?.close();
    disposeProcessSignals?.();
  }
}
