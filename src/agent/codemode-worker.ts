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
  const context = createContext(
    {},
    { name: "codemode", codeGeneration: { strings: false, wasm: false } }
  );
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
  try {
    const { result, logs, truncated } = realm.finish(await script(realm.tools, realm.console));
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
