import { Worker } from "node:worker_threads";
import type { PipelineStepContext, RemoteStepAdapter } from "../core/pipeline.js";
import {
  decodeWorkerError,
  encodeWorkerError,
  type WorkerThreadData,
  type WorkerThreadRequest,
  type WorkerThreadResponse,
} from "./worker-thread-protocol.js";

/** Configure the module export and worker-pool limits for a thread adapter. */
export interface WorkerThreadAdapterOptions {
  /** Explicit worker module. Compile TypeScript to JavaScript before using it with Node. */
  module: URL;
  /** Named (or "default") function export accepting (payload, WorkerThreadContext). */
  exportName: string;
  /** Maximum worker threads shared by every caller of this adapter. Defaults to 1. */
  poolSize?: number;
  /** Grace period for cooperative cancellation before terminating a busy worker. Defaults to 100 ms. */
  cancelTimeoutMs?: number;
}

/** Invoke cloneable payloads through a reusable pool of Node worker threads. */
export interface WorkerThreadAdapter<TPayload = unknown> extends RemoteStepAdapter<
  object,
  TPayload,
  unknown
> {
  /** Stop accepting calls, cancel queued work, terminate active/idle threads, and await their exit. Idempotent. */
  close(): Promise<void>;
}

interface Task {
  request: Extract<WorkerThreadRequest, { type: "run" }>;
  context: PipelineStepContext<object>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onAbort(): void;
  cancelError?: Error;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker;
  task?: Task;
  error?: unknown;
  termination?: Promise<number>;
}

function cancellation(reason: unknown): Error {
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : `Worker invocation cancelled${reason === undefined ? "" : `: ${String(reason)}`}`,
    {
      cause: reason,
    }
  );
  error.name = "AbortError";
  return error;
}

/** Run an explicit module export in a lazily created, reusable Node worker pool. */
export function createWorkerThreadAdapter<TPayload = unknown>(
  options: WorkerThreadAdapterOptions
): WorkerThreadAdapter<TPayload> {
  const { exportName, poolSize = 1, cancelTimeoutMs = 100 } = options;
  const module = options.module.href;
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new RangeError("poolSize must be a positive finite integer");
  }
  if (!Number.isFinite(cancelTimeoutMs) || cancelTimeoutMs < 0 || cancelTimeoutMs > 2_147_483_647) {
    throw new RangeError("cancelTimeoutMs must be between 0 and 2147483647");
  }
  if (!exportName.trim()) throw new TypeError("exportName must be non-empty");
  if (options.module.protocol !== "file:" && options.module.protocol !== "data:") {
    throw new TypeError("Worker module must be a file: or data: URL");
  }
  const queue: Task[] = [];
  const slots = new Set<Slot>();
  let nextId = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  function settle(task: Task, error: unknown, value?: unknown): void {
    task.context.signal?.removeEventListener("abort", task.onAbort);
    clearTimeout(task.cancelTimer);
    if (task.cancelError !== undefined) task.reject(task.cancelError);
    else if (error !== undefined) task.reject(error);
    else task.resolve(value);
  }

  function stop(slot: Slot, error: unknown): Promise<number> {
    slot.error ??= error;
    slot.termination ??= slot.worker.terminate();
    return slot.termination;
  }

  function createSlot(): Slot {
    const worker = new Worker(new URL("./worker-thread-runtime.js", import.meta.url), {
      workerData: { module, exportName } satisfies WorkerThreadData,
      // --input-type is valid for the caller's eval/stdin but not this file-based worker.
      execArgv: process.execArgv.filter(
        (arg, index, args) =>
          arg !== "--input-type" &&
          !arg.startsWith("--input-type=") &&
          args[index - 1] !== "--input-type"
      ),
    });
    const slot: Slot = { worker };
    slots.add(slot);
    worker.on("message", (message: WorkerThreadResponse) => {
      const task = slot.task;
      if (!task || task.request.id !== message.id || slot.termination) return;
      try {
        if (message.type === "result" || message.type === "error") {
          slot.task = undefined;
          settle(
            task,
            message.type === "error" ? decodeWorkerError(message.error) : undefined,
            message.type === "result" ? message.value : undefined
          );
          worker.unref();
          dispatch();
        } else if (!task.cancelError) {
          if (message.type === "log") task.context.log[message.level](...message.args);
          else task.context.reportProgress(message.progress);
        }
      } catch (error) {
        void stop(slot, error);
      }
    });
    worker.on("error", (error) => {
      void stop(slot, error);
    });
    worker.on("exit", (code) => {
      slots.delete(slot);
      if (slot.task) {
        settle(
          slot.task,
          slot.error ?? new Error(`Worker exited before returning a result (exit code ${code})`)
        );
        slot.task = undefined;
      }
      dispatch();
    });
    return slot;
  }

  function dispatch(): void {
    while (!closed && queue.length > 0) {
      let slot = [...slots].find((candidate) => !candidate.task && !candidate.termination);
      if (!slot && slots.size >= poolSize) return;
      const task = queue.shift()!;
      try {
        slot ??= createSlot();
        slot.task = task;
        slot.worker.ref();
        slot.worker.postMessage(task.request);
      } catch (error) {
        if (slot) void stop(slot, error);
        else settle(task, error);
      }
    }
  }

  return {
    engine: "node:worker_threads",
    target: `${module}#${exportName}`,
    invoke(payload, context) {
      if (closed) return Promise.reject(new Error("Worker adapter is closed"));
      if (context.signal?.aborted) return Promise.reject(cancellation(context.signal.reason));
      return new Promise((resolve, reject) => {
        // Snapshot now, including queued input; non-cloneable payloads fail before starting a worker.
        const request: Task["request"] = {
          type: "run",
          id: ++nextId,
          payload: structuredClone(payload),
          context: {
            attemptId: context.attemptId,
            correlationId: context.correlationId,
            cwd: context.cwd,
            dryRun: context.dryRun,
            parentRunId: context.parentRunId,
            runId: context.runId,
          },
        };
        if (closed) throw new Error("Worker adapter is closed");
        const task: Task = {
          request,
          context,
          resolve,
          reject,
          onAbort() {
            task.cancelError = cancellation(context.signal?.reason);
            const queued = queue.indexOf(task);
            if (queued >= 0) {
              queue.splice(queued, 1);
              settle(task, task.cancelError);
              return;
            }
            const slot = [...slots].find((candidate) => candidate.task === task);
            if (!slot || slot.termination) return;
            try {
              slot.worker.postMessage({
                type: "cancel",
                id: request.id,
                error: encodeWorkerError(task.cancelError),
              } satisfies WorkerThreadRequest);
              task.cancelTimer = setTimeout(() => {
                void stop(slot, task.cancelError);
              }, cancelTimeoutMs);
            } catch (error) {
              void stop(slot, error);
            }
          },
        };
        queue.push(task);
        context.signal?.addEventListener("abort", task.onAbort, { once: true });
        // Payload getters can abort during structuredClone, before the listener is registered.
        if (context.signal?.aborted) task.onAbort();
        dispatch();
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      const error = cancellation(new Error("Worker adapter closed"));
      for (const task of queue.splice(0)) {
        task.cancelError = error;
        settle(task, error);
      }
      closing = Promise.all(
        [...slots].map((slot) => {
          if (slot.task) slot.task.cancelError = error;
          return stop(slot, error);
        })
      ).then(() => undefined);
      return closing;
    },
  };
}
