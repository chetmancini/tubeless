import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { CliContext } from "./cli.js";
import { PipelineDefinitionError, type PipelineContext, type PipelineError } from "./pipeline.js";
import {
  loadPipelineCommandModule,
  loadPlanSourceModule,
  type WorkbenchPipelineCommand,
  type WorkbenchPlanSource,
} from "./pipeline-module.js";

/** Stable shell exit codes for the workbench command family. */
export const TUBELESS_WORKBENCH_EXIT_CODE = {
  success: 0,
  usage: 1,
  load: 2,
  definition: 3,
  validation: 4,
  planning: 5,
  execution: 6,
  cancellation: 7,
} as const;

/**
 * How long after the first delivery of a terminal signal a repeat is
 * treated as the trampoline's forwarded duplicate of the same keypress
 * rather than a deliberate force-quit. The forwarded copy lands within
 * milliseconds; an operator pressing again needs at least a second.
 */
export const DUPLICATE_SIGNAL_WINDOW_MS = 300;

/** Default local SQLite path shared by `tubeless run --store`, `history`, and `ui`. */
export const DEFAULT_PIPELINE_RUN_STORE = ".tubeless/runs.sqlite";

export interface WorkbenchCliIo {
  cwd: string;
  signal?: AbortSignal;
  stderr: { write(chunk: string): boolean | void };
  stdout: { write(chunk: string): boolean | void };
}

/** Write a chunk and wait when the destination applies backpressure. */
export async function writeCliChunk(
  output: { write(chunk: string): boolean | void },
  chunk: string
): Promise<void> {
  interface BackpressuredWriter {
    destroyed?: boolean;
    errored?: Error | null;
    off?(event: string, listener: (...args: never[]) => void): unknown;
    once?(event: string, listener: (...args: never[]) => void): unknown;
  }
  // SAFETY: write() returning false, plus destroyed/errored, are Node writable
  // stream signals. Test IO objects omit those fields and skip the drain wait.
  const stream = output as BackpressuredWriter;
  if (stream.destroyed) {
    throw stream.errored instanceof Error
      ? stream.errored
      : new Error("Cannot write to a closed stream.");
  }
  if (output.write(chunk) !== false) return;
  if (typeof stream.once !== "function" || typeof stream.off !== "function") return;
  if (stream.destroyed) {
    throw stream.errored instanceof Error
      ? stream.errored
      : new Error("Cannot write to a closed stream.");
  }
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => {
      fail(error);
    };
    const onClose = () => {
      fail(
        stream.errored instanceof Error
          ? stream.errored
          : new Error("Cannot write to a closed stream.")
      );
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off!("drain", onDrain);
      stream.off!("error", onError);
      stream.off!("close", onClose);
    };
    stream.once!("error", onError);
    stream.once!("drain", onDrain);
    stream.once!("close", onClose);
  });
}

export function writeUsageError(io: WorkbenchCliIo, message: string, usage: string): number {
  io.stderr.write(`Error: ${message}\n\n${usage}`);
  return TUBELESS_WORKBENCH_EXIT_CODE.usage;
}

export function isDefinitionError(error: unknown): boolean {
  return (
    error instanceof PipelineDefinitionError ||
    (error instanceof Error && error.name === "PipelineDefinitionError")
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : undefined;
}

export function isCliHelpRequested(error: unknown): error is { helpText: string } {
  return (
    errorName(error) === "CliHelpRequested" &&
    typeof error === "object" &&
    error !== null &&
    "helpText" in error &&
    typeof error.helpText === "string"
  );
}

export function isCliValidationError(
  error: unknown
): error is { errors: readonly string[]; helpText: string } {
  return (
    errorName(error) === "CliValidationError" &&
    typeof error === "object" &&
    error !== null &&
    "errors" in error &&
    Array.isArray(error.errors) &&
    "helpText" in error &&
    typeof error.helpText === "string"
  );
}

export function isPipelineExecutionError(
  error: unknown
): error is { result: { errors: PipelineError[] } } {
  return (
    errorName(error) === "PipelineExecutionError" &&
    typeof error === "object" &&
    error !== null &&
    "result" in error &&
    typeof error.result === "object" &&
    error.result !== null &&
    "errors" in error.result &&
    Array.isArray(error.result.errors)
  );
}

/** Map a thrown CLI or pipeline error onto the workbench exit-code family. */
export function toExitCode(error: unknown): number {
  if (isCliHelpRequested(error)) return TUBELESS_WORKBENCH_EXIT_CODE.success;
  if (isCliValidationError(error)) return TUBELESS_WORKBENCH_EXIT_CODE.validation;
  if (isPipelineExecutionError(error)) {
    const errors = error.result.errors;
    if (errors.length > 0 && errors.every(({ kind }) => kind === "cancellation")) {
      return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
    if (errors.some(({ phase }) => phase === "planning")) {
      return TUBELESS_WORKBENCH_EXIT_CODE.planning;
    }
    return TUBELESS_WORKBENCH_EXIT_CODE.execution;
  }
  return TUBELESS_WORKBENCH_EXIT_CODE.execution;
}

async function loadWorkbenchModule<T>(
  fileArgument: string,
  io: WorkbenchCliIo,
  load: (filePath: string) => Promise<T>
): Promise<T | { exitCode: number }> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    return await load(filePath);
  } catch (error) {
    const exitCode = isDefinitionError(error)
      ? TUBELESS_WORKBENCH_EXIT_CODE.definition
      : TUBELESS_WORKBENCH_EXIT_CODE.load;
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode };
  }
}

export async function loadPipelineCommand(
  fileArgument: string,
  exportName: string | undefined,
  io: WorkbenchCliIo
): Promise<{ command: WorkbenchPipelineCommand; exportName: string } | { exitCode: number }> {
  return loadWorkbenchModule(fileArgument, io, (filePath) =>
    loadPipelineCommandModule(filePath, exportName)
  );
}

export async function loadPlanSource(
  fileArgument: string,
  exportName: string | undefined,
  io: WorkbenchCliIo
): Promise<{ source: WorkbenchPlanSource } | { exitCode: number }> {
  return loadWorkbenchModule(fileArgument, io, async (filePath) => ({
    source: await loadPlanSourceModule(filePath, exportName),
  }));
}

export function writeCommandLine(
  output: WorkbenchCliIo["stdout"] | WorkbenchCliIo["stderr"],
  message: string,
  ...optionalParams: string[]
): void {
  output.write(`${[message, ...optionalParams].join(" ")}\n`);
}

export function commandContext(
  io: WorkbenchCliIo,
  signal: AbortSignal,
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">
): Partial<CliContext> {
  const context: Partial<CliContext> = {
    cwd: io.cwd,
    log: {
      error: (message, ...params) =>
        writeCommandLine(
          io.stderr,
          String(message ?? ""),
          ...params.map((param) => String(param ?? ""))
        ),
      log: (message, ...params) =>
        writeCommandLine(
          io.stdout,
          String(message ?? ""),
          ...params.map((param) => String(param ?? ""))
        ),
      warn: (message, ...params) =>
        writeCommandLine(
          io.stderr,
          String(message ?? ""),
          ...params.map((param) => String(param ?? ""))
        ),
    },
    signal,
  };
  if (pipelineContext) context.pipelineContext = pipelineContext;
  return context;
}

export interface ManagedWorkbenchSignal {
  cleanup(): void;
  signal: AbortSignal;
  wasInterrupted(): boolean;
}

/**
 * Watch for the first delivery of each terminal signal with a persistent
 * listener that also swallows the immediate duplicates a Ctrl-C produces
 * under the Node trampoline (direct terminal delivery plus the forwarded
 * copy) while a cleanup's synchronous phase is still blocking. A later
 * signal is a deliberate force-quit: the listener removes itself and
 * re-raises the signal so default termination takes over.
 */
export function onFirstProcessSignal(
  signals: readonly NodeJS.Signals[],
  onFirst: (signal: NodeJS.Signals) => void
): () => void {
  const listeners = signals.map((signal) => {
    // Per-signal state: a window armed by SIGINT must not silence a
    // first SIGTERM's graceful stop or turn it into a force-quit.
    let armed = false;
    let armedUntil = 0;
    const listener = (): void => {
      // A duplicate can arrive while the first delivery's synchronous
      // work still blocks, or queued behind it in the event loop: the
      // window is armed after `onFirst` returns, so the queued copy of
      // the same press still lands inside it.
      if (armed) {
        if (Date.now() < armedUntil) return;
        // Past the window this is a second, deliberate press: drop
        // every listener and re-raise so default termination force-quits
        // a cleanup that will not finish.
        removeAll();
        process.kill(process.pid, signal);
        return;
      }
      armed = true;
      onFirst(signal);
      // Arm after `onFirst` returns: its synchronous work (abort
      // dispatch) may block past the wall-clock window, and the queued
      // duplicate must still be classified as part of this press.
      armedUntil = Date.now() + DUPLICATE_SIGNAL_WINDOW_MS;
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  const removeAll = (): void => {
    for (const { signal, listener } of listeners) {
      process.removeListener(signal, listener);
    }
  };
  return removeAll;
}

export function manageWorkbenchSignal(io: WorkbenchCliIo): ManagedWorkbenchSignal {
  if (io.signal) {
    return {
      cleanup: () => {},
      signal: io.signal,
      wasInterrupted: () => io.signal?.aborted === true,
    };
  }

  const controller = new AbortController();
  let interrupted = false;
  const dispose = onFirstProcessSignal(["SIGINT"], () => {
    interrupted = true;
    io.stderr.write("SIGINT received; cancelling pipeline work.\n");
    controller.abort();
  });
  return {
    cleanup: dispose,
    signal: controller.signal,
    wasInterrupted: () => interrupted,
  };
}
