#!/usr/bin/env node

/**
 * Package `bin` target for `tubeless`.
 *
 * The workbench needs Bun (see `engines.bun` in package.json) because Bun loads
 * TypeScript pipeline modules directly, but npm and `npx` users only have
 * Node.js. This launcher is what a shell, npm or `bunx` starts, and it has three
 * branches:
 *
 * - started by Bun and new enough: load the real workbench entry in this process;
 * - started by Bun, too old: print the upgrade message and exit with the usage code;
 * - started by Node.js: find `bun` on `PATH` and replace this process with it, so
 *   signals, exit codes and the terminal behave exactly as a direct Bun start;
 *   without a usable `bun`, print what to install and exit with the usage code.
 *
 * `src/workbench/workbench-bin.ts` stays the direct entry for callers that start
 * it explicitly under either runtime.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "../cli/cli-exit.js";
import {
  MINIMUM_BUN_VERSION,
  missingBunMessage,
  outdatedBunMessage,
  versionAtLeast,
} from "./workbench-runtime.js";

/** First executable named `name` on `PATH`, or undefined when none can be run. */
function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

function missingBun(): void {
  process.stderr.write(missingBunMessage());
  process.exitCode = TUBELESS_WORKBENCH_EXIT_CODE.usage;
}

const bunVersion = process.versions.bun;
if (bunVersion !== undefined) {
  // Loaded lazily: workbench-bin.ts runs the CLI at import time, so a static import
  // would execute it during the Node.js branch too, before Bun replaces the process.
  if (versionAtLeast(bunVersion, MINIMUM_BUN_VERSION)) await import("./workbench-bin.js");
  else {
    process.stderr.write(outdatedBunMessage(bunVersion));
    process.exitCode = TUBELESS_WORKBENCH_EXIT_CODE.usage;
  }
} else {
  const args = [fileURLToPath(import.meta.url), ...process.argv.slice(2)];
  if (typeof process.execve === "function") {
    const bun = findOnPath("bun");
    // argv[0] stays the found path: version-manager shims dispatch on its basename.
    // The environment is passed explicitly: Node.js 22.18 ignores the documented
    // `process.env` default and would hand Bun an empty one, losing TUBELESS_TOKEN,
    // HOME and PATH.
    if (bun) process.execve(bun, [bun, ...args], process.env);
    else missingBun();
  } else {
    // Windows only, where Node.js has no execve and this file is untested. Mirror
    // the child's inherited stdio and exit status; Bun still does the real work.
    const result = spawnSync("bun", args, { stdio: "inherit" });
    if (result.error) missingBun();
    else process.exitCode = result.status ?? TUBELESS_WORKBENCH_EXIT_CODE.usage;
  }
}
