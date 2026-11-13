#!/usr/bin/env bun

/**
 * Entry point for the `tubeless` CLI binary.
 *
 * The workbench requires Bun (see `engines.bun` in package.json) because Bun
 * loads TypeScript pipeline modules directly.
 */

import { runWorkbenchCli, type WorkbenchCliIo } from "./workbench.js";
import { parseRunArgs } from "./workbench-run.js";

const argv = process.argv.slice(2);
let jsonRun = false;
if (argv[0] === "run") {
  try {
    jsonRun = parseRunArgs(argv.slice(1)).values.json === true;
  } catch {
    // Let normal dispatch report invalid arguments without loading application code.
  }
}

let stdout: WorkbenchCliIo["stdout"] = process.stdout;
if (jsonRun) {
  const output = process.stdout;
  const reportOutput = {
    write: output.write.bind(output),
    once: output.once.bind(output),
    off: output.off.bind(output),
    get destroyed() {
      return output.destroyed;
    },
    get errored() {
      return output.errored;
    },
  };
  stdout = reportOutput;
  // This executable owns the process: reserve stdout before any user imports and
  // keep routing late application writes to stderr after the run finishes, too.
  // Bun's native console bypasses stdout.write, so redirect both independently.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  // Use the global constructor so Bun initializes node:console exports only
  // after redirection, including dependencies that import its named log function.
  globalThis.console = new console.Console({ stdout: process.stderr, stderr: process.stderr });
}

process.exitCode = await runWorkbenchCli(argv, {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdin: process.stdin,
  stdout,
});
