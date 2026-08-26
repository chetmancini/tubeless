import { stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRunId } from "./pipeline.js";
import type { PipelineStudioConfig } from "./workbench-studio.js";
import type { PipelineRunStudioCommand, PipelineRunStudioLauncher } from "./run-store-ui.js";
import {
  executePipelineCommandValues,
  type WorkbenchStructuredPipelineCommand,
} from "./workbench-run.js";
import {
  commandContext,
  errorMessage,
  loadPipelineCommand,
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
      // SAFETY: A dynamic import of an arbitrary user module yields an untyped
      // export namespace; every value is validated by isPipelineStudioConfig
      // before use, so the Record<string, unknown> shape is the module boundary.
      import(pathToFileURL(filePath).href) as Promise<Record<string, unknown>>,
    ]);
    const configs = Object.entries(moduleExports).filter((entry) =>
      isPipelineStudioConfig(entry[1])
    );
    const unique = configs.filter(
      ([, value], index) => configs.findIndex(([, other]) => other === value) === index
    );
    if (unique.length === 0) {
      throw new Error("Module does not export a definePipelineStudio config.");
    }
    if (unique.length > 1) {
      throw new Error(
        `Module exports multiple studio configs (${unique.map(([name]) => name).join(", ")}).`
      );
    }
    // SAFETY: unique[0] passed isPipelineStudioConfig, whose type guard
    // establishes the PipelineStudioConfig shape before it is returned.
    return { config: unique[0]![1] as PipelineStudioConfig, filePath };
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

  const host = parsed.values.host ?? "127.0.0.1";
  const isLoopbackHost = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (specs.length > 0 && !isLoopbackHost) {
    return writeUsageError(io, "Browser-triggered execution requires a loopback --host.", UI_USAGE);
  }

  const launchController = new AbortController();
  const activeLaunches = new Set<Promise<number>>();
  const registrations: {
    command: WorkbenchStructuredPipelineCommand;
    commandIo: WorkbenchCliIo;
    descriptor: PipelineRunStudioCommand;
    runIdPrefix: string;
  }[] = [];
  for (const spec of specs) {
    const commandIo = { ...io, cwd: spec.cwd };
    const loaded = await loadPipelineCommand(spec.filePath, spec.exportName, commandIo);
    if ("exitCode" in loaded) return loaded.exitCode;
    if (
      !("parseValues" in loaded.command) ||
      typeof loaded.command.parseValues !== "function" ||
      !("execute" in loaded.command) ||
      typeof loaded.command.execute !== "function"
    ) {
      io.stderr.write(`Error: ${spec.filePath} does not support structured studio launches.\n`);
      return TUBELESS_WORKBENCH_EXIT_CODE.load;
    }
    // SAFETY: the guard above verified the cross-realm loaded command exposes
    // both parseValues and execute as functions, matching the
    // WorkbenchStructuredPipelineCommand runtime surface.
    const launchableCommand = loaded.command as WorkbenchStructuredPipelineCommand;
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
      command: launchableCommand,
      commandIo,
      descriptor,
      runIdPrefix: loaded.command.descriptor.name,
    });
  }

  const filename = path.resolve(io.cwd, parsed.values.store ?? ".tubeless/runs.sqlite");
  let store:
    | Awaited<ReturnType<typeof import("./run-store-sqlite.js").openSqlitePipelineRunStore>>
    | undefined;
  let server:
    | Awaited<ReturnType<typeof import("./run-store-ui.js").startPipelineRunStudio>>
    | undefined;
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
              let parsedCommand: ReturnType<WorkbenchStructuredPipelineCommand["parseValues"]>;
              try {
                parsedCommand = registration.command.parseValues(
                  values,
                  commandContext(registration.commandIo, launchController.signal, pipelineContext)
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
                launchController.signal,
                pipelineContext
              );
              activeLaunches.add(execution);
              void execution.finally(() => activeLaunches.delete(execution));
              return { accepted: true, runId };
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
      if (io.signal?.aborted) {
        resolve();
        return;
      }
      if (io.signal) {
        io.signal.addEventListener("abort", () => resolve(), { once: true });
        return;
      }
      const stop = (): void => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.execution;
  } finally {
    await server?.close();
    launchController.abort(new DOMException("The local studio is stopping.", "AbortError"));
    await Promise.allSettled(activeLaunches);
    await store?.close();
  }
}
