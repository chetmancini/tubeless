import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve a real npm CLI for pack/install smoke tests.
 *
 * Bun and npm put workspace `node_modules/.bin` first on PATH when running
 * package scripts. An orphaned or nested `npm` package there can shadow the
 * Node-bundled CLI (e.g. npm 2.x) and break `npm pack --pack-destination`.
 * Prefer the npm next to the running Node binary.
 */
export function resolveNpm() {
  const siblingName = process.platform === "win32" ? "npm.cmd" : "npm";
  const sibling = join(dirname(process.execPath), siblingName);
  if (existsSync(sibling)) return sibling;
  return "npm";
}

/**
 * Extract the packed tarball filename from `npm pack --json` stdout.
 *
 * npm ≤9 returns `[{ filename, ... }]`.
 * npm ≥10 returns `{ "<name>": { filename, ... } }`.
 */
export function packedTarballFilename(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `npm pack returned non-JSON output:\n${stdout}\n${error instanceof Error ? error.message : error}`
    );
  }

  if (Array.isArray(parsed)) {
    const filename = parsed[0]?.filename;
    if (typeof filename === "string" && filename.length > 0) return filename;
  } else if (parsed && typeof parsed === "object") {
    for (const entry of Object.values(parsed)) {
      const filename = entry?.filename;
      if (typeof filename === "string" && filename.length > 0) return filename;
    }
  }

  throw new Error(`npm pack returned no tarball filename:\n${stdout}`);
}
