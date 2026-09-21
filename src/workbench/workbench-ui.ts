import * as path from "node:path";
import { parseArgs } from "node:util";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import type { SqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { loadPipelineProjectFile, createModuleRegistration } from "./workbench-project-loader.js";
import type { PipelineRunEventReader } from "../run-store/run-store.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLauncher,
} from "../studio/run-store-ui.js";
import { WorkbenchLaunchSession } from "./workbench-launch-session.js";
import { executePipelineCommandValues } from "./workbench-run.js";
import {
  commandContext,
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  onFirstProcessSignal,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const UI_USAGE = `Usage: tubeless ui [options] [project-file]

Serve the local pipeline studio from an append-only SQLite run store or a
finished NDJSON trace. Load pipelines from a project, or register
definePipelineCommand modules directly, and only with a writable SQLite store.

Options:
      --command <path> Register a launchable pipeline command (repeatable)
  -e, --export <name>  Select the export when registering exactly one command
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
      --trace <path>    Read a finished NDJSON trace artifact (history-only)
      --host <value>    Bind address (default: 127.0.0.1)
      --port <number>   HTTP port (default: 4317)
  -h, --help            Show this help
`;

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
      trace: { type: "string" },
    },
    strict: true,
  });
}

export async function runUi(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: UI_USAGE,
      parse: parseUiArgs,
      async run(parsed, commandIo) {
        if (parsed.positionals.length > 1) {
          return writeUsageError(commandIo, "Pass at most one project file.", UI_USAGE);
        }
        const directCommandFiles = parsed.values.command ?? [];
        const projectFile = parsed.positionals[0];
        if (parsed.values.store && parsed.values.trace) {
          return writeUsageError(io, "Use --store or --trace, not both.", UI_USAGE);
        }
        if (parsed.values.trace && (directCommandFiles.length > 0 || projectFile)) {
          return writeUsageError(
            io,
            "An NDJSON trace is read-only and cannot register launchable commands.",
            UI_USAGE
          );
        }
        if (parsed.values.export && (directCommandFiles.length !== 1 || projectFile)) {
          return writeUsageError(
            io,
            "--export requires exactly one registered --command.",
            UI_USAGE
          );
        }
        const port = Number(parsed.values.port ?? "4317");
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          return writeUsageError(io, "--port must be an integer from 0 to 65535.", UI_USAGE);
        }

        const sources = directCommandFiles.map((file) =>
          createModuleRegistration(file, io.cwd, parsed.values.export)
        );
        if (projectFile) {
          const loaded = await loadPipelineProjectFile(projectFile, io);
          if ("exitCode" in loaded) return loaded.exitCode;
          sources.push(...loaded.registrations);
        }
        const identities = new Set<string>();
        for (const source of sources) {
          if (identities.has(source.identity)) {
            return writeUsageError(
              io,
              `Studio command source ${JSON.stringify(source.source)} is duplicated.`,
              UI_USAGE
            );
          }
          identities.add(source.identity);
        }

        const host = (parsed.values.host ?? "127.0.0.1").toLowerCase();
        const isLoopbackHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
        if (sources.length > 0 && !isLoopbackHost) {
          return writeUsageError(
            io,
            "Browser-triggered execution requires a loopback --host.",
            UI_USAGE
          );
        }

        const studioStopController = new AbortController();
        const launchSessions = new Map<string, WorkbenchLaunchSession>();
        const activeLaunches = new Set<Promise<void>>();
        let markStudioStopping = (): void => undefined;
        const studioStopping = new Promise<void>((resolve) => {
          markStudioStopping = resolve;
        });
        const registrations: {
          command: WorkbenchPipelineCommand;
          commandIo: WorkbenchCliIo;
          descriptor: PipelineRunStudioCommand;
        }[] = [];
        for (const source of sources) {
          const loaded = await source.loadCommand(io);
          if ("exitCode" in loaded) return loaded.exitCode;
          const descriptor: PipelineRunStudioCommand = {
            canPlan: true,
            id: source.id ?? `${source.source}#${loaded.exportName}`,
            name: source.name ?? loaded.command.descriptor.name,
            parameters: loaded.command.descriptor.parameters,
          };
          if (loaded.command.descriptor.description !== undefined) {
            descriptor.description = loaded.command.descriptor.description;
          }
          registrations.push({
            command: loaded.command,
            commandIo: loaded.commandIo,
            descriptor,
          });
        }
        const registrationIds = new Set<string>();
        for (const registration of registrations) {
          if (registrationIds.has(registration.descriptor.id)) {
            return writeUsageError(
              io,
              `Studio command id ${JSON.stringify(registration.descriptor.id)} is duplicated.`,
              UI_USAGE
            );
          }
          registrationIds.add(registration.descriptor.id);
        }

        const filename = path.resolve(
          io.cwd,
          parsed.values.trace ?? parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE
        );
        let store: PipelineRunEventReader | undefined;
        let writableStore: SqlitePipelineRunStore | undefined;
        let server:
          | Awaited<ReturnType<typeof import("../studio/run-store-ui.js").startPipelineRunStudio>>
          | undefined;
        let disposeProcessSignals: (() => void) | undefined;
        let storeOpened = false;
        try {
          const { startPipelineRunStudio } = await import("../studio/run-store-ui.js");
          if (parsed.values.trace) {
            const { openNdjsonPipelineRunStore } = await import("../run-store/run-store-ndjson.js");
            store = await openNdjsonPipelineRunStore(filename);
          } else {
            const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
            writableStore = await openSqlitePipelineRunStore(filename);
            store = writableStore;
          }
          storeOpened = true;
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
                    let session!: WorkbenchLaunchSession;
                    session = new WorkbenchLaunchSession({
                      onRunRecorded(runId) {
                        launchSessions.set(runId, session);
                      },
                      signal: studioStopController.signal,
                      stopping: studioStopping,
                      store: writableStore!,
                    });
                    let parsedCommand: ReturnType<WorkbenchPipelineCommand["parseValues"]>;
                    try {
                      parsedCommand = registration.command.parseValues(
                        values,
                        commandContext(
                          registration.commandIo,
                          session.signal,
                          session.pipelineContext
                        )
                      );
                    } catch (error) {
                      return { accepted: false, errors: [errorMessage(error)] };
                    }
                    if (parsedCommand.kind === "error") {
                      return { accepted: false, errors: parsedCommand.errors };
                    }
                    if (parsedCommand.kind === "help") {
                      return { accepted: false, errors: ["Help is not a launchable value set."] };
                    }
                    const execution = executePipelineCommandValues(
                      registration.command,
                      parsedCommand.values,
                      registration.commandIo,
                      session.signal,
                      session.pipelineContext
                    );
                    const tracked = session.track(execution, (error) => {
                      try {
                        registration.commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
                      } catch {
                        console.error(
                          error instanceof Error ? (error.stack ?? error.message) : error
                        );
                      }
                    });
                    activeLaunches.add(tracked.settled);
                    void tracked.settled.then(() => {
                      activeLaunches.delete(tracked.settled);
                      const runId = session.runId;
                      if (runId && launchSessions.get(runId) === session) {
                        launchSessions.delete(runId);
                      }
                    });
                    return tracked.acknowledgement;
                  },
                  cancel(runId) {
                    const session = launchSessions.get(runId);
                    if (!session) return { cancelled: false };
                    session.abort(new DOMException("The run was cancelled.", "AbortError"));
                    return { cancelled: true, runId };
                  },
                  liveRunIds() {
                    return [...launchSessions.keys()];
                  },
                };
          const studioOptions: Parameters<typeof startPipelineRunStudio>[0] = {
            host,
            launcher,
            port,
            store,
          };
          if (isLoopbackHost && writableStore) {
            studioOptions.history = {
              clear: () => writableStore!.clearHistory(),
              isBusy: () => activeLaunches.size > 0,
            };
          }
          server = await startPipelineRunStudio(studioOptions);
          io.stdout.write(`Tubeless local studio: ${server.url}\n`);
          io.stdout.write(`${parsed.values.trace ? "Trace artifact" : "Run store"}: ${filename}\n`);
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
            disposeProcessSignals = onFirstProcessSignal(["SIGINT", "SIGTERM"], () => stop());
          });
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          io.stderr.write(`Error: ${errorMessage(error)}\n`);
          return parsed.values.trace && !storeOpened
            ? TUBELESS_WORKBENCH_EXIT_CODE.load
            : TUBELESS_WORKBENCH_EXIT_CODE.execution;
        } finally {
          markStudioStopping();
          studioStopController.abort(
            new DOMException("The local studio is stopping.", "AbortError")
          );
          await server?.close();
          await Promise.allSettled(activeLaunches);
          await store?.close();
          disposeProcessSignals?.();
        }
      },
    },
    argv,
    io
  );
}
