import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove stale TypeScript outputs from a previous build. TypeScript does not
 * delete its own outputs, so dist/ keeps files that no longer correspond to
 * any emit: declaration maps from when declarationMap was enabled, and
 * JavaScript, maps, and declarations whose src/ module was since deleted
 * (test modules never emit, so they never have live outputs either).
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(packageRoot, "dist");
const src = join(packageRoot, "src");

function hasLiveSource(stem) {
  return !stem.endsWith(".test") && existsSync(join(src, `${stem}.ts`));
}

if (existsSync(dist)) {
  for (const name of readdirSync(dist)) {
    if (name.endsWith(".d.ts.map")) {
      rmSync(join(dist, name));
      continue;
    }
    const match = name.match(/^(.*)\.(js|js\.map|d\.ts)$/);
    if (match && !hasLiveSource(match[1])) {
      rmSync(join(dist, name));
    }
  }
}
