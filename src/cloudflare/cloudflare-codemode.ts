import { createAbortError } from "../utilities/abort.js";
import type { CodemodeExecutionResult, CodemodeExecutor } from "../agent/codemode-executor.js";
import {
  describeScriptError,
  REALM_SETUP,
  SCRIPT_FILENAME,
  scriptLogLines,
} from "../agent/codemode-realm.js";

/** The `worker_loaders` binding's `load` method, as used by the code-mode executor. */
export interface WorkerLoaderLike {
  load(code: {
    readonly compatibilityDate: string;
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, string>>;
    readonly globalOutbound: null;
    readonly limits?: { readonly cpuMs?: number };
  }): { getEntrypoint(name: string): unknown };
}

/** Options for createWorkerLoaderCodemodeExecutor. */
export interface WorkerLoaderCodemodeOptions {
  /** CPU budget for each script's Dynamic Worker. Defaults to 30000 ms. */
  readonly cpuMs?: number;
  /** Compatibility date for the Dynamic Worker. Defaults to 2026-10-01. */
  readonly compatibilityDate?: string;
}

const ENTRYPOINT = "TubelessCodemode";

// The Dynamic Worker module that runs one script. It receives only the call bridge, as an RPC
// function stub, and the realm setup's tools and console; it has no env or outbound network.
// Specifiers are interpolated so this source text is not mistaken for this module's imports.
const MAIN = `import { WorkerEntrypoint } from ${JSON.stringify("cloudflare:workers")};
const setup = ${REALM_SETUP};
const describe = ${describeScriptError.toString()};
const logLines = ${scriptLogLines.toString()};
export class ${ENTRYPOINT} extends WorkerEntrypoint {
  async run(names, maxLines, maxCharacters, call) {
    const realm = setup((name, input) => call(name, input), names, maxLines, maxCharacters);
    const failed = (message) => {
      const { logs, truncated } = realm.finish(undefined);
      return { ok: false, message, logs: logLines(logs), logsTruncated: !!truncated };
    };
    let script;
    try {
      script = (await import(${JSON.stringify(`./${SCRIPT_FILENAME}`)})).default;
    } catch (error) {
      return failed(describe(error));
    }
    try {
      const { result, logs, truncated } = realm.finish(await script(realm.tools, realm.console));
      if (typeof result !== "string") return failed("Script result must be JSON-serializable");
      return { ok: true, result, logs: logLines(logs), logsTruncated: !!truncated };
    } catch (error) {
      return failed(describe(error));
    }
  }
}
`;

interface ScriptEntrypoint {
  run(
    names: string,
    maxLines: number,
    maxCharacters: number,
    call: (name: unknown, input: unknown) => Promise<string>
  ): Promise<unknown>;
}

/**
 * workerd compiles every module when a Dynamic Worker loads, so a script syntax error fails
 * the load rather than the module's import. Report it as the script's error.
 */
function loadFailure(error: unknown): CodemodeExecutionResult | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const line = /codemode\.js:(\d+)/.exec(message)?.[1];
  if (!message.includes("Failed to start Worker") || line === undefined) return undefined;
  const detail = /\b(SyntaxError: [^\n]*)/.exec(message)?.[1] ?? "SyntaxError: invalid script";
  return { ok: false, message: `${detail} (line ${line})`, logs: [], logsTruncated: false };
}

/** Accept only the result shape the module returns; anything else is a sandbox failure. */
function executionResult(value: unknown): CodemodeExecutionResult {
  const result = value as Partial<Record<string, unknown>> | null;
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray(result.logs) &&
    result.logs.every((line) => typeof line === "string") &&
    typeof result.logsTruncated === "boolean"
  ) {
    const { logs, logsTruncated } = result as { logs: string[]; logsTruncated: boolean };
    if (result.ok === true && typeof result.result === "string")
      return { ok: true, result: result.result, logs, logsTruncated };
    if (result.ok === false && typeof result.message === "string")
      return { ok: false, message: result.message, logs, logsTruncated };
  }
  throw new Error("Dynamic Worker returned an invalid script result");
}

/**
 * Run each code-mode script in a fresh Cloudflare Dynamic Worker from a `worker_loaders`
 * binding. Workers disallow string code generation; the Dynamic Worker gets no env and no
 * outbound network, and its CPU is bounded. Pass to `codemode: { executor }`.
 */
export function createWorkerLoaderCodemodeExecutor(
  loader: WorkerLoaderLike,
  options: WorkerLoaderCodemodeOptions = {}
): CodemodeExecutor {
  const { cpuMs = 30_000, compatibilityDate = "2026-10-01" } = options;
  if (!loader || typeof loader.load !== "function")
    throw new TypeError("createWorkerLoaderCodemodeExecutor requires a worker_loaders binding");
  if (!Number.isSafeInteger(cpuMs) || cpuMs < 1)
    throw new RangeError("cpuMs must be a positive safe integer");
  return {
    async execute(execution, signal) {
      if (signal.aborted) throw createAbortError(signal, "Codemode script");
      const worker = loader.load({
        compatibilityDate,
        mainModule: "main.js",
        modules: {
          "main.js": MAIN,
          // The header shares the script's first line, so reported line numbers match.
          [SCRIPT_FILENAME]: `export default async function (tools, console) {${execution.code}\n}\n`,
        },
        globalOutbound: null,
        limits: { cpuMs },
      });
      // SAFETY: the module above defines this entrypoint and its run method.
      const entrypoint = worker.getEntrypoint(ENTRYPOINT) as ScriptEntrypoint;
      const running = entrypoint.run(
        JSON.stringify(execution.tools),
        execution.maxLogLines,
        execution.maxLogCharacters,
        (name, input) => execution.call(String(name), String(input))
      );
      // A Dynamic Worker cannot be terminated from here; stop waiting, and the harness rejects
      // its later calls. Its CPU limit bounds work that keeps running.
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(createAbortError(signal, "Codemode script"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        let value: unknown;
        try {
          value = await Promise.race([running, aborted]);
        } catch (error) {
          const failure = signal.aborted ? undefined : loadFailure(error);
          if (failure) return failure;
          throw error;
        }
        return executionResult(value);
      } finally {
        signal.removeEventListener("abort", onAbort!);
        void running.catch(() => {});
      }
    },
  };
}
