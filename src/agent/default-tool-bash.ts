import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { PipelineStepContext } from "../core/pipeline-types.js";
import { createAbortError, throwIfAborted } from "../utilities/abort.js";
import { MAX_OUTPUT_BYTES } from "./default-tool-files.js";
import { ToolError } from "./tools.js";

export function bashTool(
  input: { command: string; cwd?: string | null; timeoutMs?: number | null },
  context: Pick<PipelineStepContext<object>, "cwd" | "signal">
) {
  throwIfAborted(context.signal, "Bash tool");
  const cwd = resolve(context.cwd, input.cwd ?? ".");
  const grouped = process.platform !== "win32";
  let child;
  try {
    child = spawn("bash", ["--noprofile", "--norc", "-c", input.command], {
      cwd,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new ToolError("BASH_FAILED", String(error).slice(0, 4096));
  }
  return new Promise<{
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    truncated: boolean;
  }>((resolveResult, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remaining = MAX_OUTPUT_BYTES;
    let truncated = false;
    let timedOut = false;
    let stopping = false;
    let spawnError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const capture = (destination: Buffer[], chunk: Buffer) => {
      const length = Math.min(remaining, chunk.length);
      if (length > 0) destination.push(Buffer.from(chunk.subarray(0, length)));
      remaining -= length;
      if (length < chunk.length) truncated = true;
    };
    const kill = (signal: NodeJS.Signals, afterClose = false) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ESRCH" || (afterClose && error.code === "EPERM"))
        )
          return;
        spawnError ??= error instanceof Error ? error : new Error(String(error));
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      context.signal?.removeEventListener("abort", stop);
      // Cleanup can race with the already-exited process group's removal.
      if (stopping && grouped) kill("SIGKILL", true);
      if (context.signal?.aborted) reject(createAbortError(context.signal, "Bash tool"));
      else if (spawnError) reject(new ToolError("BASH_FAILED", spawnError.message.slice(0, 4096)));
      else
        resolveResult({
          cwd,
          stdout: new TextDecoder().decode(Buffer.concat(stdout), { stream: truncated }),
          stderr: new TextDecoder().decode(Buffer.concat(stderr), { stream: truncated }),
          exitCode,
          signal,
          timedOut,
          truncated,
        });
    });
    context.signal?.addEventListener("abort", stop, { once: true });
    if (context.signal?.aborted) stop();
  });
}
