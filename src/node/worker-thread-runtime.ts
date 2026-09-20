import { parentPort, workerData } from "node:worker_threads";
import { format } from "node:util";
import {
  decodeWorkerError,
  encodeWorkerError,
  type WorkerThreadContext,
  type WorkerThreadData,
  type WorkerThreadRequest,
  type WorkerThreadResponse,
} from "./worker-thread-protocol.js";

const port = parentPort;
if (port === null) throw new Error("Worker adapter runtime requires a worker thread");
// SAFETY: createWorkerThreadAdapter owns the workerData shape.
const data = workerData as WorkerThreadData;
const exports = await import(data.module);
const handler: unknown = exports[data.exportName];
if (typeof handler !== "function") {
  throw new Error(`Worker module export ${JSON.stringify(data.exportName)} must be a function`);
}
let current: { id: number; controller: AbortController } | undefined;

port.on("message", async (message: WorkerThreadRequest) => {
  if (message.type === "cancel") {
    if (current?.id === message.id) current.controller.abort(decodeWorkerError(message.error));
    return;
  }
  const task = { id: message.id, controller: new AbortController() };
  current = task;
  const send = (response: WorkerThreadResponse) => {
    // Drop detached callbacks from a completed invocation rather than attributing them to the next one.
    if (current === task) port.postMessage(response);
  };
  const log = (level: "log" | "warn" | "error", args: unknown[]) => {
    // Formatting inside the worker also permits logging values that cannot be cloned (e.g. functions).
    send({ type: "log", id: task.id, level, args: [format(...args)] });
  };
  const context: WorkerThreadContext = {
    ...message.context,
    signal: task.controller.signal,
    log: {
      log: (...args) => log("log", args),
      warn: (...args) => log("warn", args),
      error: (...args) => log("error", args),
    },
    reportProgress: (progress) => send({ type: "progress", id: task.id, progress }),
  };
  try {
    const value: unknown = await handler(message.payload, context);
    send({ type: "result", id: task.id, value });
  } catch (error) {
    send({ type: "error", id: task.id, error: encodeWorkerError(error) });
  } finally {
    current = undefined;
  }
});
