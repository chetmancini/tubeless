import type { PipelineLogger, PipelineStepProgress } from "../core/pipeline.js";

export interface WorkerThreadMetadata {
  attemptId: string;
  correlationId?: string;
  cwd: string;
  dryRun: boolean;
  parentRunId?: string;
  runId: string;
}

/** Explicit context supplied to the exported worker function; domain input is its first argument. */
/** Provide cancellation, logging, progress, and run metadata to a worker export. */
export interface WorkerThreadContext extends WorkerThreadMetadata {
  log: PipelineLogger;
  reportProgress(progress: PipelineStepProgress): void;
  signal: AbortSignal;
}

export interface WorkerThreadData {
  module: string;
  exportName: string;
}

export interface WorkerThreadError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: WorkerThreadError;
}

export type WorkerThreadRequest =
  | { type: "run"; id: number; payload: unknown; context: WorkerThreadMetadata }
  | { type: "cancel"; id: number; error: WorkerThreadError };

export type WorkerThreadResponse =
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; error: WorkerThreadError }
  | { type: "log"; id: number; level: keyof PipelineLogger; args: unknown[] }
  | { type: "progress"; id: number; progress: PipelineStepProgress };

// Send plain error records: structured cloning Error drops custom names and codes.
export function encodeWorkerError(value: unknown, depth = 0): WorkerThreadError {
  const error = value instanceof Error ? value : new Error(String(value));
  const code = "code" in error ? error.code : undefined;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
    cause:
      depth < 5 && error.cause !== undefined
        ? encodeWorkerError(error.cause, depth + 1)
        : undefined,
  };
}

export function decodeWorkerError(value: WorkerThreadError): Error {
  const error = new Error(value.message, {
    cause: value.cause === undefined ? undefined : decodeWorkerError(value.cause),
  });
  error.name = value.name;
  if (value.stack !== undefined) error.stack = value.stack;
  if (value.code !== undefined) Object.assign(error, { code: value.code });
  return error;
}
