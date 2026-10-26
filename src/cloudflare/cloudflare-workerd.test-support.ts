import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

function relativeImports(source: string, directory: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)].map(
    (match) => posix.normalize(posix.join(directory, match[1]!))
  );
}

/** A workerd module manifest: the entry plus every built module it reaches through relative imports. */
export function manifestModules(entry: string): Record<string, { type: "esm"; contents: string }> {
  const modules: Record<string, { type: "esm"; contents: string }> = {
    "worker.js": { type: "esm", contents: entry },
  };
  const pending = relativeImports(entry, "");
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (modules[name]) continue;
    const contents = readFileSync(join(dist, name), "utf8");
    modules[name] = { type: "esm", contents };
    pending.push(...relativeImports(contents, posix.dirname(name)));
  }
  return modules;
}
