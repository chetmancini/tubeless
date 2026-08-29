#!/usr/bin/env node

/**
 * Node trampoline for the `tubeless` CLI.
 *
 * The workbench requires Bun (see `engines.bun` in package.json) because Bun
 * loads TypeScript pipeline modules directly. Shipping a Node shebang keeps
 * the published binary invocable through `npx` and any Node environment:
 * under Bun we run the CLI directly, and under Node we re-exec this file with
 * Bun, printing an actionable message instead of
 * `env: bun: No such file or directory` when Bun is missing.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MISSING_BUN_EXIT_CODE = 127;

interface RelayResult {
  error?: Error;
  status: number | null;
  signal?: NodeJS.Signals | null;
}

function relayExitCode(relay: RelayResult): number {
  if (relay.error) {
    process.stderr.write(`tubeless could not launch Bun: ${relay.error.message}\n`);
    return MISSING_BUN_EXIT_CODE;
  }
  if (relay.status !== null) return relay.status;
  if (relay.signal) {
    // Re-raise so shells and test runners observe the real signal death.
    process.kill(process.pid, relay.signal);
  }
  return MISSING_BUN_EXIT_CODE;
}

if ("Bun" in globalThis) {
  const { runWorkbenchCli } = await import("./workbench.js");
  process.exitCode = await runWorkbenchCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stderr: process.stderr,
    stdout: process.stdout,
  });
} else {
  // `engines.bun` is a tested-with pin rather than a hard floor: the previous
  // bun shebang ran with any installed Bun, so no version gate runs here.
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    // SAFETY: spawnSync errors are always Node system errors, so the shape
    // matches NodeJS.ErrnoException and `code` is the failing syscall's errno.
    if ((probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        [
          "The tubeless CLI requires Bun 1.3.14 or later.",
          "",
          "Install Bun:",
          "  curl -fsSL https://bun.sh/install | bash",
          "",
          "Then retry, or use bunx directly:",
          "  bunx tubeless --help",
          "",
        ].join("\n")
      );
      process.exitCode = MISSING_BUN_EXIT_CODE;
    } else {
      process.stderr.write(`tubeless could not launch Bun: ${probe.error.message}\n`);
      process.exitCode = MISSING_BUN_EXIT_CODE;
    }
  } else {
    const relay = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    process.exitCode = relayExitCode(relay);
  }
}
