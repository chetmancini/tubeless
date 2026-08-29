import { spawnSync } from "node:child_process";

/** Exit code used when Bun cannot be launched to run the workbench. */
export const MISSING_BUN_EXIT_CODE = 127;

/** Shape of the subset of `spawnSync` results the trampoline consumes. */
export interface TrampolineSpawnResult {
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
  readonly probeBun: () => TrampolineSpawnResult;
  /**
   * Relay the bin through Bun with the caller's real stdio inherited.
   */
  readonly relayToBun: (binPath: string, argv: readonly string[]) => TrampolineSpawnResult;
  /** Write a diagnostic or install message to the operator. */
  readonly writeError: (message: string) => void;
  /** Current process id, used to re-raise relay signal deaths. */
  readonly pid: number;
  /** Send a signal to a process, used to re-raise relay signal deaths. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
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

function launchMessage(error: TrampolineSpawnResult["error"]): string {
  return `tubeless could not launch Bun: ${error?.message}\n`;
}

/**
 * Exit code for a finished relay process. Re-raises signal deaths on the
 * current process so shells and test runners observe the real termination.
 */
export function relayExitCode(
  relay: TrampolineSpawnResult,
  io: Pick<TrampolineIo, "pid" | "kill">
): number {
  if (relay.error) return MISSING_BUN_EXIT_CODE;
  if (relay.status !== null) return relay.status;
  if (relay.signal) io.kill(io.pid, relay.signal);
  return MISSING_BUN_EXIT_CODE;
}

/** Build the production trampoline IO around Node's `spawnSync`. */
export function createNodeTrampolineIo(): TrampolineIo {
  return {
    probeBun: () => {
      const result = spawnSync("bun", ["--version"], { stdio: "pipe" });
      return { error: result.error, status: result.status, signal: result.signal };
    },
    relayToBun: (binPath, argv) => {
      const result = spawnSync("bun", [binPath, ...argv], { stdio: "inherit" });
      return { error: result.error, status: result.status, signal: result.signal };
    },
    writeError: (message) => {
      process.stderr.write(message);
    },
    pid: process.pid,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
  };
}

/**
 * Relay the CLI through Bun from a Node process. A missing Bun (spawn ENOENT)
 * prints install instructions; any other launch failure reports the raw error;
 * otherwise the relay's exit status or signal is forwarded.
 *
 * `engines.bun` is a tested-with pin rather than a hard floor — the previous
 * bun shebang ran with any installed Bun — so no version gate runs here.
 */
export function runTrampoline(binPath: string, argv: readonly string[], io: TrampolineIo): number {
  const probe = io.probeBun();
  if (probe.error) {
    io.writeError(probe.error.code === "ENOENT" ? INSTALL_BUN_MESSAGE : launchMessage(probe.error));
    return MISSING_BUN_EXIT_CODE;
  }
  const relay = io.relayToBun(binPath, argv);
  if (relay.error) {
    io.writeError(launchMessage(relay.error));
    return MISSING_BUN_EXIT_CODE;
  }
  return relayExitCode(relay, io);
}
