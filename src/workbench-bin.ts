#!/usr/bin/env bun

import { runWorkbenchCli } from "./workbench.js";

process.exitCode = await runWorkbenchCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdout: process.stdout,
});
