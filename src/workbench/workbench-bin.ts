#!/usr/bin/env bun

/**
 * Entry point for the `tubeless` CLI binary.
 *
 * The workbench requires Bun (see `engines.bun` in package.json) because Bun
 * loads TypeScript pipeline modules directly.
 */

import { runWorkbenchCli } from "./workbench.js";

process.exitCode = await runWorkbenchCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdout: process.stdout,
});
