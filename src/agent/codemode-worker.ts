import { createContext, Script } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import type {
  CodemodeHostMessage,
  CodemodeWorkerData,
  CodemodeWorkerMessage,
} from "./codemode-protocol.js";
import {
  describeScriptError,
  REALM_SETUP,
  SCRIPT_FILENAME,
  scriptLogLines,
} from "./codemode-realm.js";

interface Realm {
  readonly tools: unknown;
  readonly console: unknown;
  run(script: unknown, done: (ok: boolean, value: unknown) => void): void;
  finish(value: unknown): { result?: unknown; logs: unknown; truncated: unknown };
}

const data = workerData as CodemodeWorkerData;
const port = parentPort!;
const replies = new Map<number, (reply: string) => void>();
let nextCall = 0;

// Unawaited calls may reject after the script settles; the script's own result reports failures.
process.on("unhandledRejection", () => {});

port.on("message", ({ id, reply }: CodemodeHostMessage) => {
  const resolve = replies.get(id);
  replies.delete(id);
  resolve?.(reply);
});

function bridge(name: string, input: string): Promise<string> {
  return new Promise((resolve) => {
    const id = nextCall++;
    replies.set(id, resolve);
    port.postMessage({ type: "call", id, name, input } satisfies CodemodeWorkerMessage);
  });
}

async function main(): Promise<CodemodeWorkerMessage> {
  // Null prototype: a host-realm `{}` would expose the host `Function` via its constructor chain.
  const context = createContext(Object.create(null), {
    name: "codemode",
    codeGeneration: { strings: false, wasm: false },
  });
  const realm: Realm = new Script(REALM_SETUP, { filename: "codemode-setup.js" }).runInContext(
    context
  )(bridge, JSON.stringify(data.tools), data.maxLogLines, data.maxLogCharacters);
  const failed = (message: string): CodemodeWorkerMessage => {
    const { logs, truncated } = realm.finish(undefined);
    return {
      type: "done",
      ok: false,
      message,
      logs: scriptLogLines(logs),
      logsTruncated: !!truncated,
    };
  };
  let script: (tools: unknown, console: unknown) => unknown;
  try {
    script = new Script(`(async (tools, console) => {\n${data.code}\n})`, {
      filename: SCRIPT_FILENAME,
      lineOffset: -1,
    }).runInContext(context);
  } catch (error) {
    return failed(describeScriptError(error));
  }
  // Host code must never await a sandbox value, resolve a promise with one, or return one
  // from an async function: each makes the engine call the value's script-controlled
  // `then` with host-realm functions. The realm reports through a callback instead, and
  // the outcome crosses inside a host-realm wrapper object.
  const outcome = await new Promise<{ readonly ok: boolean; readonly value: unknown }>((resolve) =>
    realm.run(script, (ok, value) => resolve({ ok, value }))
  );
  if (!outcome.ok) return failed(describeScriptError(outcome.value));
  try {
    const { result, logs, truncated } = realm.finish(outcome.value);
    if (typeof result !== "string") return failed("Script result must be JSON-serializable");
    return {
      type: "done",
      ok: true,
      result,
      logs: scriptLogLines(logs),
      logsTruncated: !!truncated,
    };
  } catch (error) {
    return failed(describeScriptError(error));
  }
}

port.postMessage(await main());
