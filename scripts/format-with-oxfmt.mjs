import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function formatWithOxfmt(contents, filepath) {
  const result = spawnSync("oxfmt", ["--stdin-filepath", filepath], {
    cwd: packageRoot,
    encoding: "utf8",
    input: contents,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`oxfmt failed for ${filepath}: ${result.stderr}`);
  }
  return result.stdout;
}
