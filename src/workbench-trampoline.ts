import { type ChildProcess, spawn } from "node:child_process";
import { spawnSync } from "node:child_process";

/** Exit code used when Bun cannot be launched to run the workbench. */
export const MISSING_BUN_EXIT_CODE = 127;

/** Signals a supervisor may send to the trampoline; forwarded to the relay. */
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Shape of the probe result the trampoline consumes. */
export interface TrampolineProbeResult {
  error?: { message: string; code?: string | undefined };
  status: number | null;
}

/** Terminal outcome of the relay process, once it stops. */
export interface TrampolineRelayOutcome {
  error?: { message: string; code?: string | undefined };
  status: number | null;
  signal?: NodeJS.Signals | null;
}

/** Process plumbing the trampoline needs; injectable for tests. */
export interface TrampolineIo {
  /**
   * Probe for Bun without touching the caller's terminal: output is piped
   * and discarded so `bun --version` never leaks into the operator's stdio.
   */
  readonly probeBun: () => TrampolineProbeResult;
  /**
   * Start the relay child with the caller's real stdio. The returned handle
   * must stop resolving once the child exits, dies by signal, or fails to
   * spawn, and must deliver signals sent to `sendSignal` to the child.
   */
  readonly startRelay: (
    binPath: string,
    argv: readonly string[]
  ) => {
    outcome: Promise<TrampolineRelayOutcome>;
    sendSignal: (signal: NodeJS.Signals) => void;
  };
  /** Write a diagnostic or install message to the operator. */
  readonly writeError: (message: string) => void;
  /** Current process id, used to re-raise relay signal deaths. */
  readonly pid: number;
  /** Send a signal to a process, used to re-raise relay signal deaths. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Register a handler for supervisor signals, return a disposer. */
  readonly onSignal: (
    signals: readonly NodeJS.Signals[],
    handler: (signal: NodeJS.Signals) => void
  ) => () => void;
}

const INSTALL_BUN_MESSAGE = [
  "The tubeless CLI requires Bun 1.3.14 or later.",
  "",
  "Install Bun:",
  "  curl -fsSL https://bun.sh/install | bash",
  "",
  "Then retry, or use bunx directly:",
  "  bunx tubeless --help",
  "",
].join("\n");

function launchMessage(error: TrampolineRelayOutcome["error"]): string {
  return `tubeless could not launch Bun: ${error?.message}\n`;
}

/**
 * Exit code for a finished relay process. Re-raises signal deaths on the
 * current process so shells and test runners observe the real termination.
 */
export function relayExitCode(
  relay: TrampolineRelayOutcome,
  io: Pick<TrampolineIo, "pid" | "kill">
): number {
  if (relay.error) return MISSING_BUN_EXIT_CODE;
  if (relay.status !== null) return relay.status;
  if (relay.signal) io.kill(io.pid, relay.signal);
  return MISSING_BUN_EXIT_CODE;
}

/** Build the production trampoline IO around Node's child-process module. */
export function createNodeTrampolineIo(): TrampolineIo {
  return {
    probeBun: () => {
      const result = spawnSync("bun", ["--version"], { stdio: "pipe" });
      return { error: result.error, status: result.status };
    },
    startRelay: (binPath, argv) => {
      const child: ChildProcess = spawn("bun", [binPath, ...argv], { stdio: "inherit" });
      const outcome = new Promise<TrampolineRelayOutcome>((resolve) => {
        // `spawn` emits `error` for a failure to launch and `close` after a
        // launched child exits or dies by signal; at most one precedes the
        // settle, and the first resolve wins either way.
        child.once("error", (error) => {
          // SAFETY: child-process `error` events are always Node system
          // errors, so the shape matches NodeJS.ErrnoException and `code`
          // is the failing syscall's errno.
          const errno = (error as NodeJS.ErrnoException).code;
          resolve({ error: { message: error.message, code: errno }, status: null });
        });
        child.once("close", (status, signal) => {
          resolve({ status, signal });
        });
      });
      return {
        outcome,
        sendSignal: (signal) => {
          child.kill(signal);
        },
      };
    },
    writeError: (message) => {
      process.stderr.write(message);
    },
    pid: process.pid,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    onSignal: (signals, handler) => {
      const listeners = signals.map((signal) => {
        const listener = () => handler(signal);
        process.on(signal, listener);
        return { signal, listener };
      });
      return () => {
        for (const { signal, listener } of listeners) {
          process.removeListener(signal, listener);
        }
      };
    },
  };
}

/**
 * Relay the CLI through Bun from a Node process. A missing Bun (spawn ENOENT)
 * prints install instructions; any other launch failure reports the raw
 * error. While the relay runs, supervisor signals (SIGINT/SIGTERM/SIGHUP)
 * sent to the trampoline are forwarded to the Bun child so the pipeline
 * cannot outlive a cancelled caller; the relay's exit status or signal is
 * then forwarded.
 *
 * `engines.bun` is a tested-with pin rather than a hard floor — the previous
 * bun shebang ran with any installed Bun — so no version gate runs here.
 */
export async function runTrampoline(
  binPath: string,
  argv: readonly string[],
  io: TrampolineIo
): Promise<number> {
  const probe = io.probeBun();
  if (probe.error) {
    io.writeError(probe.error.code === "ENOENT" ? INSTALL_BUN_MESSAGE : launchMessage(probe.error));
    return MISSING_BUN_EXIT_CODE;
  }
  const relay = io.startRelay(binPath, argv);
  const disposeSignalForwarding = io.onSignal(FORWARDED_SIGNALS, (signal) => {
    relay.sendSignal(signal);
  });
  try {
    const outcome = await relay.outcome;
    // Dispose forwarding before computing the exit code: `relayExitCode`
    // re-raises the child's signal on this process, and an active listener
    // would swallow that self-signal and forward it to the dead child,
    // turning a real signal death into exit 127.
    disposeSignalForwarding();
    if (outcome.error) {
      io.writeError(launchMessage(outcome.error));
      return MISSING_BUN_EXIT_CODE;
    }
    return relayExitCode(outcome, io);
  } finally {
    // Idempotent safety net in case an earlier path is added above.
    disposeSignalForwarding();
  }
}
