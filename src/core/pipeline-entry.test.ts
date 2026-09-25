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
  project: ["core", "utilities"],
  workbench: ["cli", "core", "project", "render", "run-store", "studio", "tracing", "utilities"],
};

function moduleName(file: string): string {
  return relative(dist, file).split(sep)[0];
}

describe("module runtime boundaries", () => {
  it("keeps runtime dependencies acyclic, including lazy imports and re-exports", () => {
    const visited = new Set<string>();
    const active: string[] = [];
    const visit = (file: string): void => {
      const cycleStart = active.indexOf(file);
      if (cycleStart !== -1) {
        throw new Error(
          `Runtime import cycle: ${[...active.slice(cycleStart), file]
            .map((entry) => relative(dist, entry))
            .join(" -> ")}`
        );
      }
      if (visited.has(file)) return;
      visited.add(file);
      active.push(file);
      for (const dependency of dependencies(file)) visit(dependency);
      active.pop();
    };
    for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (name.endsWith(".js")) visit(resolve(dist, name));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("encapsulates execution errors and lifecycle emission below orchestration", () => {
    const contracts: Record<string, readonly string[]> = {
      "core/pipeline-execution-error.js": [
        "core/pipeline-diagnostics.js",
        "core/pipeline-step-metadata.js",
        "core/pipeline-validation.js",
        "utilities/abort.js",
        "utilities/tubeless-error.js",
      ],
      "core/lifecycle.js": ["tracing/tracing-internal.js"],
    };
    for (const [entry, allowed] of Object.entries(contracts)) {
      for (const dependency of dependencies(resolve(dist, entry))) {
        expect(allowed, `${entry} reaches ${relative(dist, dependency)}`).toContain(
          relative(dist, dependency).split(sep).join("/")
        );
      }
    }
    for (const name of readdirSync(resolve(dist, "core"))) {
      if (!name.endsWith(".js") || name === "lifecycle.js") continue;
      expect(
        dependencies(resolve(dist, "core", name)),
        `${name} bypasses lifecycle trace ownership`
      ).not.toContain(resolve(dist, "tracing/tracing-internal.js"));
    }
  });

  it("keeps project declarations independent of executable integrations", () => {
    const pending = [resolve(dist, "project/project.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      expect(
        ["project", "core", "tracing", "utilities"].includes(moduleName(file)),
        `Project entrypoint reaches executable integration: ${relative(dist, file)}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

  it("keeps CLI authoring independent of workbench, storage and Studio", () => {
    const pending = [resolve(dist, "cli/cli.js")];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      expect(
        ["cli", "core", "node", "reporter", "tracing", "utilities"].includes(moduleName(file)),
        `CLI entrypoint reaches operational module: ${relative(dist, file)}`
      ).toBe(true);
      pending.push(...dependencies(file));
    }
    expect(visited.size).toBeGreaterThan(1);
  });

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
      "tracing/tracing-codec.js",
      "tracing/tracing-constants.js",
      "tracing/tracing-internal.js",
      "tracing/tracing-schema.js",
      "tracing/trace-exporter-error.js",
      "tracing/wire-schema.js",
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
