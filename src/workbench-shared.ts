import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { CliContext } from "./cli.js";
import { PipelineDefinitionError, type PipelineContext, type PipelineError } from "./pipeline.js";
import {
  loadPipelineCommandModuleWithName,
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

export interface WorkbenchCliIo {
  cwd: string;
  signal?: AbortSignal;
  stderr: { write(chunk: string): void };
  stdout: { write(chunk: string): void };
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

export async function loadPipelineCommand(
  fileArgument: string,
  exportName: string | undefined,
  io: WorkbenchCliIo
): Promise<{ command: WorkbenchPipelineCommand; exportName: string } | { exitCode: number }> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    return await loadPipelineCommandModuleWithName(filePath, exportName);
  } catch (error) {
    const exitCode = isDefinitionError(error)
      ? TUBELESS_WORKBENCH_EXIT_CODE.definition
      : TUBELESS_WORKBENCH_EXIT_CODE.load;
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode };
  }
}

export async function loadPlanSource(
  fileArgument: string,
  exportName: string | undefined,
  io: WorkbenchCliIo
): Promise<{ source: WorkbenchPlanSource } | { exitCode: number }> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    return { source: await loadPlanSourceModule(filePath, exportName) };
  } catch (error) {
    const exitCode = isDefinitionError(error)
      ? TUBELESS_WORKBENCH_EXIT_CODE.definition
      : TUBELESS_WORKBENCH_EXIT_CODE.load;
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode };
  }
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
  const onSigint = (): void => {
    interrupted = true;
    io.stderr.write("SIGINT received; cancelling pipeline work.\n");
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  return {
    cleanup: () => process.removeListener("SIGINT", onSigint),
    signal: controller.signal,
    wasInterrupted: () => interrupted,
  };
}
