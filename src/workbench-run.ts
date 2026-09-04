import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readlink, realpath, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { isAbortError } from "./abort.js";
import type { PipelineContext } from "./pipeline.js";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import { renderPipelineError } from "./render.js";
import type { PipelineRunEventStore } from "./run-store.js";
import type { PipelineTraceExporter } from "./tracing.js";
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
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const RUN_USAGE = `Usage: tubeless run [options] <command-file> [-- <command-args...>]

Execute an exported definePipelineCommand using its own validated CLI contract.

Options:
  -e, --export <name>   Select a command export when the file has more than one
      --store <path>    Append run events to a local SQLite database
      --trace <path>    Write NDJSON traces to a file, or - for stdout
                        (command output then goes to stderr)
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
        trace: { type: "string" },
      },
      strict: true,
    }),
  };
}

async function executePipelineCommand(
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
  command: WorkbenchPipelineCommand,
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

  const storePath = parsed.parsed.values.store
    ? path.resolve(io.cwd, parsed.parsed.values.store)
    : undefined;
  const tracePath =
    parsed.parsed.values.trace && parsed.parsed.values.trace !== "-"
      ? path.resolve(io.cwd, parsed.parsed.values.trace)
      : undefined;
  if (
    storePath !== undefined &&
    tracePath !== undefined &&
    (await destinationsConflict(storePath, tracePath))
  ) {
    return writeUsageError(io, "--store and --trace cannot write to the same path.", RUN_USAGE);
  }

  let managedSignal: ReturnType<typeof manageWorkbenchSignal> | undefined;
  let store: PipelineRunEventStore | undefined;
  let closeTrace: (() => Promise<void>) | undefined;
  let bindTraceSignal: ((signal: AbortSignal) => void) | undefined;
  let exitCode: number = TUBELESS_WORKBENCH_EXIT_CODE.execution;
  try {
    const exporters: PipelineTraceExporter[] = [];
    if (parsed.parsed.values.store) {
      const { openSqlitePipelineRunStore } = await import("./run-store-sqlite.js");
      store = await openSqlitePipelineRunStore(path.resolve(io.cwd, parsed.parsed.values.store));
      exporters.push(store);
    }
    if (parsed.parsed.values.trace) {
      const writer = await createRunTraceWriter(parsed.parsed.values.trace, io, io.signal);
      bindTraceSignal = writer.bindSignal;
      closeTrace = writer.close;
      exporters.push(writer.exporter);
    }
    managedSignal = manageWorkbenchSignal(io);
    bindTraceSignal?.(managedSignal.signal);
    const pipelineContext =
      exporters.length > 0
        ? { tracing: { exporter: composeTraceExporters(exporters) } }
        : undefined;
    const commandIo = parsed.parsed.values.trace === "-" ? { ...io, stdout: io.stderr } : io;
    exitCode = await executePipelineCommand(
      loaded.command,
      parsed.commandArgs,
      commandIo,
      managedSignal.signal,
      pipelineContext
    );
    if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success && managedSignal.wasInterrupted()) {
      exitCode = TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    const interrupted = managedSignal?.wasInterrupted() ?? io.signal?.aborted === true;
    exitCode = interrupted ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation : toExitCode(error);
  } finally {
    try {
      await closeTrace?.();
    } catch (error) {
      io.stderr.write(`Error: ${errorMessage(error)}\n`);
      if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
    }
    try {
      await store?.close();
    } catch (error) {
      io.stderr.write(`Error: ${errorMessage(error)}\n`);
      if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
    }
    managedSignal?.cleanup();
  }
  return exitCode;
}

function composeTraceExporters(exporters: readonly PipelineTraceExporter[]): PipelineTraceExporter {
  if (exporters.length === 1) return exporters[0]!;
  const failed = new WeakSet<PipelineTraceExporter>();
  let lastError: unknown;
  const invokeHealthy = async (
    invoke: (exporter: PipelineTraceExporter) => void | Promise<void>
  ): Promise<void> => {
    let succeeded = 0;
    let roundError: unknown;
    for (const exporter of exporters) {
      if (failed.has(exporter)) continue;
      try {
        await invoke(exporter);
        succeeded += 1;
      } catch (error) {
        failed.add(exporter);
        lastError = error;
        roundError ??= error;
      }
    }
    if (succeeded === 0) {
      const error = roundError ?? lastError;
      if (error !== undefined) throw error;
    }
  };
  return {
    export(event) {
      return invokeHealthy((exporter) => exporter.export(event));
    },
    flush() {
      return invokeHealthy((exporter) => exporter.flush?.());
    },
  };
}

async function createRunTraceWriter(
  destination: string,
  io: WorkbenchCliIo,
  signal?: AbortSignal
): Promise<{
  bindSignal(signal: AbortSignal): void;
  close(): Promise<void>;
  exporter: PipelineTraceExporter;
}> {
  let writeSignal = signal;
  const currentSignal = () => writeSignal;

  if (destination === "-") {
    let writeError: Error | undefined;
    return {
      bindSignal(next) {
        writeSignal = next;
      },
      close: async () => {
        if (writeSignal?.aborted) return;
        if (writeError) throw writeError;
      },
      exporter: {
        async export(event) {
          if (writeError) throw writeError;
          try {
            await writeCliChunk(io.stdout, `${JSON.stringify(event)}\n`, currentSignal());
          } catch (error) {
            writeError = error instanceof Error ? error : new Error(String(error));
            throw writeError;
          }
        },
      },
    };
  }

  const filename = path.resolve(io.cwd, destination);
  await mkdir(path.dirname(filename), { recursive: true });
  const stream = createWriteStream(filename);
  let writeError: Error | undefined;
  stream.on("error", (error) => {
    writeError = error;
  });
  const destroyOnAbort = () => {
    if (!stream.destroyed) stream.destroy();
  };
  // The signal is caller-owned and may outlive this writer (embedders reuse
  // one signal across runs), so never leave a stale listener behind: detach
  // before rebinding and on every terminal close path.
  let boundSignal: AbortSignal | undefined;
  const detachSignal = () => {
    boundSignal?.removeEventListener("abort", destroyOnAbort);
    boundSignal = undefined;
  };
  const bindSignal = (next: AbortSignal) => {
    detachSignal();
    writeSignal = next;
    if (next.aborted) {
      destroyOnAbort();
      return;
    }
    boundSignal = next;
    next.addEventListener("abort", destroyOnAbort, { once: true });
  };
  await waitForWriteStreamOpen(stream, signal);
  if (writeSignal) bindSignal(writeSignal);
  return {
    bindSignal,
    close: () =>
      new Promise((resolve, reject) => {
        const retainedError =
          writeError ?? (stream.errored instanceof Error ? stream.errored : undefined);
        detachSignal();
        if (retainedError) {
          reject(retainedError);
          return;
        }
        if (writeSignal?.aborted || stream.destroyed) {
          destroyOnAbort();
          resolve();
          return;
        }
        stream.end((error?: Error | null) => {
          if (error) reject(error);
          else if (writeError) reject(writeError);
          else resolve();
        });
      }),
    exporter: {
      async export(event) {
        if (writeError) throw writeError;
        await writeCliChunk(stream, `${JSON.stringify(event)}\n`, currentSignal());
        if (writeError) throw writeError;
      },
    },
  };
}

async function waitForWriteStreamOpen(stream: WriteStream, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    stream.destroy();
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
  if (stream.errored) throw stream.errored;
  if (!stream.pending) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function destinationsConflict(storePath: string, tracePath: string): Promise<boolean> {
  if (await pathsShareIdentity(storePath, tracePath)) return true;
  const storeTargets = new Set([storePath, await canonicalDestination(storePath)]);
  for (const storeTarget of storeTargets) {
    for (const suffix of ["-journal", "-shm", "-wal"] as const) {
      if (await pathsShareIdentity(`${storeTarget}${suffix}`, tracePath)) return true;
    }
  }
  return false;
}

async function canonicalDestination(filename: string, depth = 0): Promise<string> {
  if (depth > 32) return path.resolve(filename);
  try {
    return await realpath(filename);
  } catch {
    // Missing leaf or dangling symlink.
  }
  try {
    const target = await readlink(filename);
    return canonicalDestination(path.resolve(path.dirname(filename), target), depth + 1);
  } catch {
    // Not a symlink.
  }
  const resolved = path.resolve(filename);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(await canonicalDestination(parent, depth + 1), path.basename(resolved));
}

async function pathsShareIdentity(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    canonicalDestination(left),
    canonicalDestination(right),
  ]);
  if (leftPath === rightPath) return true;
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
  } catch {
    // One or both dests do not exist yet.
  }
  if (leftPath.toLowerCase() !== rightPath.toLowerCase()) return false;
  return directoryIgnoresCase(
    (await nearestExistingDirectory(path.dirname(leftPath))) ??
      (await nearestExistingDirectory(path.dirname(rightPath)))
  );
}

async function nearestExistingDirectory(dir: string): Promise<string | undefined> {
  let current = dir;
  while (true) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Missing or not a directory; walk toward the root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function directoryIgnoresCase(dir: string | undefined): Promise<boolean> {
  if (dir === undefined) return true;
  const id = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const probe = path.join(dir, `.tubeless-case-${id}-a`);
  const flipped = path.join(dir, `.tubeless-case-${id}-A`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch {
    // Cannot probe; treat a case-fold match as a collision so --trace cannot
    // truncate a store on a case-insensitive volume.
    return true;
  }
  try {
    const [probeStat, flippedStat] = await Promise.all([stat(probe), stat(flipped)]);
    return probeStat.dev === flippedStat.dev && probeStat.ino === flippedStat.ino;
  } catch {
    return false;
  } finally {
    await unlink(probe).catch(() => {});
  }
}
