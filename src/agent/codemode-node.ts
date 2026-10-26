import { Worker } from "node:worker_threads";
import { createAbortError } from "../utilities/abort.js";
import type { CodemodeExecutor } from "./codemode-executor.js";
import type {
  CodemodeHostMessage,
  CodemodeWorkerData,
  CodemodeWorkerMessage,
} from "./codemode-protocol.js";

function workerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../../dist/agent/codemode-worker.js", import.meta.url)
    : new URL("./codemode-worker.js", import.meta.url);
}

// --input-type is valid for the caller's eval/stdin but not this file-based worker.
const execArgv = () =>
  process.execArgv.filter(
    (arg, index, args) =>
      arg !== "--input-type" &&
      !arg.startsWith("--input-type=") &&
      args[index - 1] !== "--input-type"
  );

/**
 * Run each code-mode script in a fresh Node or Bun worker thread with heap limits, inside a
 * `node:vm` context without string code generation, WebAssembly, `process`, `require`, `fetch`
 * or timers. This is the default executor; isolation is best-effort, not a security boundary.
 */
export function createNodeCodemodeExecutor(): CodemodeExecutor {
  // Resolve prerequisites now: runtimes with Node compatibility but no file-based worker
  // threads, such as Cloudflare Workers, fail here instead of failing every script.
  if (typeof Worker !== "function" || typeof import.meta.url !== "string")
    throw new Error("Node worker threads are unavailable in this runtime");
  const url = workerUrl();
  return {
    execute: (execution, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(createAbortError(signal, "Codemode script"));
        let settled = false;
        const worker = new Worker(url, {
          workerData: {
            code: execution.code,
            tools: execution.tools,
            maxLogLines: execution.maxLogLines,
            maxLogCharacters: execution.maxLogCharacters,
          } satisfies CodemodeWorkerData,
          execArgv: execArgv(),
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 32,
            stackSizeMb: 4,
          },
        });
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          void worker.terminate();
          settle();
        };
        const onAbort = () => finish(() => reject(createAbortError(signal, "Codemode script")));
        signal.addEventListener("abort", onAbort, { once: true });
        worker.on("message", (message: CodemodeWorkerMessage) => {
          if (settled) return;
          if (message.type === "call") {
            void execution.call(message.name, message.input).then((reply) => {
              if (!settled)
                worker.postMessage({
                  type: "reply",
                  id: message.id,
                  reply,
                } satisfies CodemodeHostMessage);
            });
            return;
          }
          const { logs, logsTruncated } = message;
          finish(() =>
            resolve(
              message.ok
                ? { ok: true, result: message.result, logs, logsTruncated }
                : { ok: false, message: message.message, logs, logsTruncated }
            )
          );
        });
        worker.on("error", (error) => finish(() => reject(error)));
        worker.on("exit", (code) =>
          finish(() => reject(new Error(`Sandbox exited with code ${code}`)))
        );
      }),
  };
}
