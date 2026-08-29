#!/usr/bin/env node

/**
 * Entry point for the `tubeless` CLI binary.
 *
 * The workbench requires Bun (see `engines.bun` in package.json) because Bun
 * loads TypeScript pipeline modules directly. The Node shebang keeps the
 * published binary invocable through `npx` and any Node environment: under
 * Bun the CLI runs directly, and under Node `runTrampoline` relaunches this
 * file with Bun, printing an actionable message instead of
 * `env: bun: No such file or directory` when Bun is missing.
 */

if ("Bun" in globalThis) {
  const { runWorkbenchCli } = await import("./workbench.js");
  process.exitCode = await runWorkbenchCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stderr: process.stderr,
    stdout: process.stdout,
  });
} else {
  const { fileURLToPath } = await import("node:url");
  const { createNodeTrampolineIo, runTrampoline } = await import("./workbench-trampoline.js");
  process.exitCode = runTrampoline(
    fileURLToPath(import.meta.url),
    process.argv.slice(2),
    createNodeTrampolineIo()
  );
}
