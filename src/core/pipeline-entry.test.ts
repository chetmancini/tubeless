import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

// Inspect emitted JavaScript so type-only contracts do not create runtime edges.
// Include re-exports, side-effect imports and lazy imports in the graph.
function dependencies(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier));
}

const allowedDependencies: Record<string, readonly string[]> = {
  core: ["tracing", "utilities"],
  tracing: [],
  utilities: [],
  node: [],
  reporter: ["core", "utilities"],
  render: ["core"],
  "run-store": ["core", "tracing", "utilities"],
  studio: ["run-store"],
  cli: ["core", "node", "reporter", "utilities"],
  testing: ["core", "utilities"],
  workbench: ["cli", "core", "render", "run-store", "studio", "tracing", "utilities"],
};

function moduleName(file: string): string {
  return relative(dist, file).split(sep)[0];
}

describe("module runtime boundaries", () => {
  it("keeps cross-module imports within the declared dependency direction", () => {
    const violations: string[] = [];
    for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (!name.endsWith(".js")) continue;
      const file = resolve(dist, name);
      const owner = moduleName(file);
      expect(allowedDependencies, `Unclassified module: ${name}`).toHaveProperty(owner);
      for (const dependency of dependencies(file)) {
        expect(existsSync(dependency), `Missing dependency: ${dependency}`).toBe(true);
        const target = moduleName(dependency);
        if (owner !== target && !allowedDependencies[owner].includes(target)) {
          violations.push(`${name} -> ${relative(dist, dependency)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the entire root import graph free of presentation, storage and exporters", () => {
    const pending = [resolve(dist, "core/pipeline.js")];
    const visited = new Set<string>();
    const tracingInternals = new Set([
      "tracing/tracing.js",
      "tracing/tracing-internal.js",
      "tracing/trace-exporter-error.js",
    ]);
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const name = relative(dist, file).split(sep).join("/");
      expect(
        ["core", "utilities"].includes(moduleName(file)) || tracingInternals.has(name),
        `Root entrypoint reaches optional module: ${name}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });
});
