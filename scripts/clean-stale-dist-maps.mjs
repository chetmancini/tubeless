import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove stale declaration maps from a previous build. TypeScript does not
 * delete its own outputs, so a dist/ built while declarationMap was enabled
 * keeps dangling .d.ts.map files that no longer correspond to any emit.
 */
const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
if (existsSync(dist)) {
  for (const name of readdirSync(dist)) {
    if (name.endsWith(".d.ts.map")) {
      rmSync(join(dist, name));
    }
  }
}
