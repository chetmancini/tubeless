import { createAbortError, throwIfAborted } from "../utilities/abort.js";

/** One script for an executor to run, with the JSON-text bridge to its tools. */
export interface CodemodeExecution {
  /** JavaScript async function body. */
  readonly code: string;
  /** Callable tool names, in declaration order. */
  readonly tools: readonly string[];
  /** Console bounds to apply inside the sandbox; Tubeless enforces exact limits afterwards. */
  readonly maxLogLines: number;
  readonly maxLogCharacters: number;
  /**
   * Call a tool with JSON input text. Resolves to the JSON text of a `CodemodeReply`, which
   * the sandbox turns into the call's value or a thrown `Error` with `code`. Never rejects.
   */
  call(name: string, input: string): Promise<string>;
}

/** A script's JSON result text and console lines, or the error that ended it. */
export type CodemodeExecutionResult =
  | {
      readonly ok: true;
      readonly result: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    };

/**
 * Runs code-mode scripts in an isolated sandbox. Tubeless owns the deadline, cancellation,
 * tool dispatch and draining; the executor runs one script and stops promptly when `signal`
 * aborts. A rejection without an aborted signal is a recoverable sandbox failure.
 */
export interface CodemodeExecutor {
  execute(execution: CodemodeExecution, signal: AbortSignal): Promise<CodemodeExecutionResult>;
}

/** The value or failure of one script call, as JSON text crossing into the sandbox. */
export type CodemodeReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A completed script's JSON result text and bounded console lines, or a recoverable failure. */
export type CodemodeScriptOutcome =
  | {
      readonly ok: true;
      readonly result: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    };

export interface CodemodeScript {
  readonly code: string;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
  readonly maxLogLines: number;
  readonly maxLogCharacters: number;
  readonly signal?: AbortSignal;
  /** Dispatch one script call. Rejections are fatal; recoverable failures resolve `ok: false`. */
  call(name: string, input: unknown, signal: AbortSignal): Promise<CodemodeReply>;
}

const reply = (value: CodemodeReply) => JSON.stringify(value);
const stoppedReply = reply({
  ok: false,
  code: "CODEMODE_STOPPED",
  message: "The script was stopped before this call could run",
});

/**
 * Run one script through an executor. The deadline and cancellation stay active until every
 * script call settles, including calls the script started without awaiting; a stop aborts
 * the executor and the running calls, and fatal call failures end the script.
 */
export async function runCodemodeScript(
  executor: CodemodeExecutor,
  script: CodemodeScript
): Promise<CodemodeScriptOutcome> {
  const { signal } = script;
  throwIfAborted(signal, "Codemode script");
  const sandbox = new AbortController();
  const nested = new AbortController();
  const active = new Set<Promise<void>>();
  let reason: "timeout" | "abort" | "fatal" | undefined;
  let fatal: { error: unknown } | undefined;
  let cancelled = false;
  // Set once the executor settles: later calls, such as from a retained bridge, are refused.
  let closed = false;
  let notifyStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    notifyStop = resolve;
  });
  // Cancel running script calls at most once; their resulting failures are not new faults.
  const cancelNested = () => {
    if (cancelled) return;
    cancelled = true;
    nested.abort(signal?.aborted ? signal.reason : undefined);
  };
  const stop = (kind: NonNullable<typeof reason>) => {
    reason ??= kind;
    sandbox.abort();
    cancelNested();
    notifyStop();
  };
  const call = (name: string, input: string): Promise<string> => {
    if (reason || closed) return Promise.resolve(stoppedReply);
    // The task settles normally on every path, so its bookkeeping promise never rejects.
    const task = (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch {
        return reply({
          ok: false,
          code: "CODEMODE_INVALID_CALL",
          message: `Input to ${name} is not JSON`,
        });
      }
      try {
        const outcome = await script.call(name, parsed, nested.signal);
        try {
          return reply(outcome);
        } catch {
          return reply({
            ok: false,
            code: "CODEMODE_INVALID_RESULT",
            message: `Tool ${name} returned a value that cannot be passed to the script as JSON`,
          });
        }
      } catch (error) {
        if (!cancelled) fatal ??= { error };
        stop("fatal");
        return stoppedReply;
      }
    })();
    const tracked = task.then(() => undefined);
    active.add(tracked);
    void tracked.then(() => active.delete(tracked));
    return task;
  };
  const timer = setTimeout(() => stop("timeout"), script.timeoutMs);
  const onAbort = () => stop("abort");
  signal?.addEventListener("abort", onAbort, { once: true });
  let result: CodemodeExecutionResult | undefined;
  let crash: { error: unknown } | undefined;
  try {
    // The constructor turns a synchronous throw from a custom executor into a rejection.
    const running = new Promise<CodemodeExecutionResult>((resolve) =>
      resolve(
        executor.execute(
          {
            code: script.code,
            tools: script.tools,
            maxLogLines: script.maxLogLines,
            maxLogCharacters: script.maxLogCharacters,
            call,
          },
          sandbox.signal
        )
      )
    ).then(
      (value) => {
        closed = true;
        result = value;
      },
      (error: unknown) => {
        closed = true;
        crash = { error };
        // A crashed sandbox will not consume its calls' results; cancel them before draining.
        cancelNested();
      }
    );
    // Stop waiting for an executor that a deadline, cancellation or fatal call ended.
    await Promise.race([running, stopped]);
    // A stopped script's late result is ignored, but its sandbox must still have been told.
    if (reason) result = undefined;
    while (active.size > 0) await Promise.allSettled([...active]);
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    sandbox.abort();
  }
  if (signal?.aborted) throw createAbortError(signal, "Codemode script");
  if (fatal) throw fatal.error;
  const empty = { logs: [], logsTruncated: false };
  if (reason === "timeout")
    return {
      ok: false,
      code: "CODEMODE_TIMEOUT",
      message: `Script and its tool calls exceeded ${script.timeoutMs} ms`,
      ...empty,
    };
  if (!result) {
    const error = crash?.error;
    return {
      ok: false,
      code: "CODEMODE_SANDBOX_ERROR",
      message: `Sandbox stopped: ${error instanceof Error ? error.message : String(error)}`,
      ...empty,
    };
  }
  const { logs, logsTruncated } = result;
  return result.ok
    ? { ok: true, result: result.result, logs, logsTruncated }
    : { ok: false, code: "CODEMODE_SCRIPT_ERROR", message: result.message, logs, logsTruncated };
}
