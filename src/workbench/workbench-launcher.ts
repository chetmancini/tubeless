#!/usr/bin/env node

/**
 * Package `bin` target for `tubeless`.
 *
 * Bun loads TypeScript pipeline modules directly; npm and `npx` may start this
 * entrypoint under Node.js.
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

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not an executable candidate; keep searching.
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
    // Node.js on Windows does not expose execve.
    const result = spawnSync("bun", args, { stdio: "inherit" });
    if (result.error) missingBun();
    else process.exitCode = result.status ?? TUBELESS_WORKBENCH_EXIT_CODE.usage;
  }
}
