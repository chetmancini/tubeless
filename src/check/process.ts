import { spawn } from "node:child_process";
import { dirname, delimiter } from "node:path";
import type { CheckProcessOutcome } from "../utilities/check-report.js";

interface CheckProcessOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

type ProcessLocation = Pick<CheckProcessOptions, "cwd" | "signal" | "env">;

/** Native outcomes remain independent of pipeline errors and repository report claims. */
export async function runCheckProcess(
  argv: readonly string[],
  timeoutMs: number,
  options: CheckProcessOptions
): Promise<CheckProcessOutcome> {
  if (process.platform === "win32")
    throw new TypeError("The node-check-v1 recipe requires a POSIX host; Windows is unsupported.");
  if (options.signal?.aborted)
    return { status: "cancelled", exitCode: null, signal: null, outputComplete: false };
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let status: "cancelled" | "timed-out" | undefined,
    spawnFailed = false,
    complete = true;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      /* The process group may already have exited. */
    }
  };
  const stop = (reason: "cancelled" | "timed-out"): void => {
    if (status) return;
    status = reason;
    kill("SIGTERM");
    escalation = setTimeout(() => {
      kill("SIGKILL");
      // Detached descendants may retain inherited pipes after the command group dies.
      // They cannot extend this command's cancellation/deadline indefinitely.
      complete = false;
      child.stdout.destroy();
      child.stderr.destroy();
    }, 250);
  };
  const abort = (): void => stop("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => stop("timed-out"), timeoutMs);
  const consume = async (
    stream: NodeJS.ReadableStream,
    write: CheckProcessOptions["stdout"]
  ): Promise<void> => {
    let remaining = 128 * 1024;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        if (bytes.length > remaining) complete = false;
        if (remaining > 0)
          write?.(bytes.subarray(0, Math.min(remaining, bytes.length)).toString("utf8"));
        remaining = Math.max(0, remaining - bytes.length);
      }
    } catch {
      complete = false;
    }
  };
  try {
    const outcome = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", () => {
          spawnFailed = true;
        });
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      }
    );
    const [exit] = await Promise.all([
      outcome,
      consume(child.stdout, options.stdout),
      consume(child.stderr, options.stderr),
    ]);
    const outputComplete = complete && !spawnFailed;
    if (status) return { status, ...exit, outputComplete };
    if (spawnFailed)
      return { status: "spawn-failed", exitCode: null, signal: null, outputComplete: false };
    if (exit.signal)
      return { status: "signalled", exitCode: null, signal: exit.signal, outputComplete };
    if (exit.exitCode !== null)
      return { status: "exited", exitCode: exit.exitCode, signal: null, outputComplete };
    return { status: "unavailable", exitCode: null, signal: null, outputComplete: false };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", abort);
    // A script must not leave background processes holding the gate open or writing later reports.
    kill("SIGKILL");
  }
}

/** Capture bounded stdout for machine-readable subprocesses while draining stderr. */
export async function captureCheckProcess(
  argv: readonly string[],
  timeoutMs: number,
  location: ProcessLocation
): Promise<CheckProcessOutcome & { stdout: string }> {
  let stdout = "";
  const outcome = await runCheckProcess(argv, timeoutMs, {
    ...location,
    stdout(text) {
      stdout += text;
    },
  });
  return { ...outcome, stdout: stdout.trim() };
}

export async function readCheckToolVersion(
  tool: "node" | "bun",
  location: ProcessLocation
): Promise<string | undefined> {
  const result = await captureCheckProcess([tool, "--version"], 5_000, location);
  if (result.status !== "exited" || result.exitCode !== 0 || !result.outputComplete)
    return undefined;
  const version = tool === "node" ? result.stdout.replace(/^v/, "") : result.stdout;
  return /^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}(?:[-+][A-Za-z0-9.+-]{1,64})?$/.test(version)
    ? version
    : undefined;
}
