import { spawn } from "node:child_process";
import { dirname, delimiter } from "node:path";
import type { PipelineStepContext } from "../core/pipeline.js";
import type { CheckProcessOutcome } from "../utilities/check-report.js";

/** Native outcomes remain independent of pipeline errors and repository report claims. */
export async function runCheckProcess(
  argv: readonly string[],
  timeoutMs: number,
  context: Pick<PipelineStepContext<object>, "cwd" | "signal" | "log">
): Promise<CheckProcessOutcome> {
  if (context.signal?.aborted)
    return { status: "cancelled", exitCode: null, signal: null, outputComplete: false };
  const child = spawn(argv[0], argv.slice(1), {
    cwd: context.cwd,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let status: "cancelled" | "timed-out" | undefined,
    spawnFailed = false,
    complete = true;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
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
  context.signal?.addEventListener("abort", abort, { once: true });
  if (context.signal?.aborted) abort();
  const timer = setTimeout(() => stop("timed-out"), timeoutMs);
  const consume = async (stream: NodeJS.ReadableStream): Promise<void> => {
    let remaining = 128 * 1024;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        if (bytes.length > remaining) complete = false;
        if (remaining > 0)
          context.log.log(bytes.subarray(0, Math.min(remaining, bytes.length)).toString("utf8"));
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
    const [exit] = await Promise.all([outcome, consume(child.stdout), consume(child.stderr)]);
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
    context.signal?.removeEventListener("abort", abort);
    // A script must not leave background processes holding the gate open or writing later reports.
    kill("SIGKILL");
  }
}
