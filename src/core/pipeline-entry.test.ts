import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { moduleReferences } from "../../scripts/module-references.js";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

const computedImportOwners = new Set([
  "node/worker-thread-runtime.js",
  "run-store/run-store-sqlite.js",
  "workbench/pipeline-module.js",
  "workbench/workbench-commands.js",
  "workbench/agent/provider.js",
]);
const specifierCache = new Map<string, readonly string[]>();

function specifiers(file: string): readonly string[] {
  let imports = specifierCache.get(file);
  if (!imports) {
    const references = moduleReferences(readFileSync(file, "utf8"));
    const name = relative(dist, file).split(sep).join("/");
    if (references.includes(undefined) && !computedImportOwners.has(name)) {
      throw new Error(`Unresolved runtime import outside an explicit module loader: ${name}`);
    }
    imports = references.filter((specifier): specifier is string => specifier !== undefined);
    specifierCache.set(file, imports);
  }
  return imports;
}

function dependencies(file: string): string[] {
  return specifiers(file)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier));
}

function externalSpecifiers(file: string): string[] {
  return specifiers(file).filter((specifier) => !specifier.startsWith("."));
}

const allowedDependencies: Record<string, readonly string[]> = {
  agent: ["core", "tracing", "utilities"],
  core: ["tracing", "utilities"],
  tracing: [],
  utilities: [],
  node: ["utilities"],
  check: ["core", "node", "utilities"],
  reporter: ["core", "utilities"],
  render: ["core"],
  "run-store": ["core", "tracing", "utilities"],
  studio: ["run-store", "tracing", "utilities"],
  // CLI cache choices consume the same pure contract vocabulary as runtime and wire validation.
  cli: ["core", "node", "reporter", "tracing", "utilities"],
  testing: ["core", "tracing", "utilities"],
  project: ["core", "utilities"],
  hosting: ["cli", "core", "project", "render", "run-store", "studio", "tracing", "utilities"],
  // The Worker Loader code-mode executor embeds agent's dependency-free script realm setup.
  cloudflare: [
    "agent",
    "cli",
    "core",
    "hosting",
    "project",
    "run-store",
    "studio",
    "tracing",
    "utilities",
  ],
  workbench: [
    "agent",
    "check",
    "cli",
    "core",
    "hosting",
    "project",
    "render",
    "reporter",
    "run-store",
    "studio",
    "tracing",
    "utilities",
  ],
};

function moduleName(file: string): string {
  return relative(dist, file).split(sep)[0];
}

function* reachableFiles(entries: readonly string[]): IterableIterator<string> {
  const pending = entries.map((entry) => resolve(dist, entry));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    yield file;
    pending.push(...dependencies(file));
  }
}

describe("module runtime boundaries", () => {
  it("keeps the optional Node recipe outside core and within its execution adapters", () => {
    for (const file of reachableFiles(["check/node-check.js"])) {
      expect(["check", "core", "node", "tracing", "utilities"]).toContain(moduleName(file));
    }
  });
  it("keeps graph scene construction independent of UI, transport and server modules", () => {
    const allowed = new Set([
      "studio/browser/graph/scene.js",
      "studio/browser/graph/dependencies.js",
      "studio/browser/graph/input.js",
      "studio/browser/graph/layout.js",
      "studio/browser/step-outcome.js",
      "studio/shared/children.js",
      "studio/shared/limits.js",
    ]);
    for (const file of reachableFiles(["studio/browser/graph/scene.js"])) {
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `Graph scene construction reaches ${name}`).toBe(true);
      expect(externalSpecifiers(file), `${name} imports an external runtime`).toEqual([]);
    }
  });

  it("keeps provider and MCP adapters out of the generic agent import graph", () => {
    const visited = new Set<string>();
    for (const file of reachableFiles(["agent/agent.js"])) {
      visited.add(file);
      expect(relative(dist, file)).not.toMatch(/openai|anthropic|provider-|mcp/);
    }
    expect(visited.has(resolve(dist, "agent/model-agent.js"))).toBe(true);
    expect(visited.has(resolve(dist, "agent/compile-agent.js"))).toBe(true);
  });

  it("keeps ticker workers independent of reporter orchestration and worker creation", () => {
    const allowed = new Set([
      "reporter/live-ticker-worker.js",
      "reporter/live-ticker-frame.js",
      "reporter/live-ticker-protocol.js",
      "reporter/reporter-format.js",
      "reporter/terminal-text.js",
    ]);
    for (const file of reachableFiles(["reporter/live-ticker-worker.js"])) {
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `Ticker worker reaches ${name}`).toBe(true);
    }
  });

  it("keeps project registry validation independent of pipeline construction", () => {
    const allowed = new Set(["project/project-registry.js", "project/project-document.js"]);
    for (const file of reachableFiles(["project/project-registry.js"])) {
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `Project registry validation reaches ${name}`).toBe(true);
    }
  });

  it("keeps the Studio request pipeline, page and API free of Node built-ins", () => {
    const entries = ["studio/server/handler.js", "studio/server/page.js", "studio/server/api.js"];
    for (const file of reachableFiles(entries)) {
      expect(externalSpecifiers(file), `${relative(dist, file)} imports a platform module`).toEqual(
        []
      );
    }
  });

  it("keeps history projection and Studio API routes free of execution, adapters and page assets", () => {
    const allowed = new Set([
      "core/pipeline-ids.js",
      "core/progress.js",
      "run-store/run-store.js",
      "run-store/run-projection.js",
      "run-store/agent-projection.js",
      "run-store/agent-history.js",
      "run-store/definition-projection.js",
      "run-store/run-store-reader.js",
      "run-store/run-store-query.js",
      "run-store/run-history.js",
      "run-store/run-store-schema.js",
      "run-store/step-plan-projection.js",
      "studio/server/api.js",
      "studio/server/children.js",
      "studio/shared/api-paths.js",
      "studio/shared/children.js",
      "studio/shared/limits.js",
      "studio/server/http.js",
      "studio/shared/protocol.js",
      "studio/shared/launch-metadata.js",
      "studio/server/state.js",
      "studio/server/history.js",
      "studio/server/run-details.js",
      "studio/shared/schema.js",
      "utilities/read-body.js",
      "utilities/abort.js",
      "utilities/http-response.js",
      "utilities/launch-identifier.js",
      "utilities/sha256.js",
      "tracing/agent-telemetry.js",
      "tracing/agent-transcript.js",
      "tracing/artifact-metadata.js",
      "tracing/graph-metadata.js",
      "tracing/tracing-schema.js",
      "tracing/tracing-constants.js",
      "tracing/wire-schema.js",
    ]);
    const entries = [
      "studio/server/api.js",
      "run-store/run-store.js",
      "run-store/agent-history.js",
    ];
    for (const file of reachableFiles(entries)) {
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `History/API boundary reaches ${name}`).toBe(true);
    }
  });

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
      "core/lifecycle.js": ["core/step-log-scope.js", "tracing/tracing-internal.js"],
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
    for (const file of reachableFiles(["project/project.js"])) {
      expect(
        ["project", "core", "tracing", "utilities"].includes(moduleName(file)),
        `Project entrypoint reaches executable integration: ${relative(dist, file)}`
      ).toBe(true);
    }
  });

  it("keeps Studio launch execution independent of command entrypoints and concrete adapters", () => {
    const workbenchInternals = new Set([
      "workbench/workbench-studio-launcher.js",
      "workbench/workbench-launch-session.js",
      "workbench/workbench-shared.js",
      "workbench/pipeline-module.js",
    ]);
    for (const file of reachableFiles(["workbench/workbench-studio-launcher.js"])) {
      const name = relative(dist, file).split(sep).join("/");
      expect(
        ["cli", "core", "hosting", "node", "reporter", "render", "tracing", "utilities"].includes(
          moduleName(file)
        ) || workbenchInternals.has(name),
        `Studio launch execution reaches an entrypoint or concrete adapter: ${name}`
      ).toBe(true);
    }
  });

  it("keeps the hosting kit free of workbench, storage adapters and the HTTP listener", () => {
    const entries = readdirSync(resolve(dist, "hosting"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => `hosting/${file}`);
    for (const file of reachableFiles(entries)) {
      const name = relative(dist, file).split(sep).join("/");
      expect(moduleName(file), `Hosting reaches ${name}`).not.toBe("workbench");
      expect(moduleName(file), `Hosting reaches ${name}`).not.toBe("cloudflare");
      expect(name).not.toMatch(
        /^run-store\/run-store-(sqlite|ndjson)\.js$|^studio\/server\/(listener|node-http|client-script)\.js$/
      );
      for (const specifier of externalSpecifiers(file)) {
        if (moduleName(file) === "hosting") {
          expect(specifier, `${name} imports ${specifier}`).not.toMatch(/^node:/);
        }
      }
    }
  });

  it("keeps collector worker entrypoints free of CLI startup and concrete storage", () => {
    const entries = [
      "workbench/collector-worker-runtime.js",
      "workbench/collector-worker.js",
      "workbench/collector-worker-host.js",
    ];
    for (const file of reachableFiles(entries)) {
      const name = relative(dist, file).split(sep).join("/");
      if (moduleName(file) === "workbench") {
        expect([
          "workbench/collector-worker-runtime.js",
          "workbench/collector-worker.js",
          "workbench/collector-worker-host.js",
          "workbench/collector-worker-protocol.js",
          "workbench/pipeline-module.js",
        ]).toContain(name);
      }
      expect(moduleName(file)).not.toBe("cloudflare");
      expect(name).not.toMatch(
        /^run-store\/run-store-(sqlite|ndjson)\.js$|^studio\/server\/(listener|node-http|client-script)\.js$/
      );
    }
  });

  it("keeps workbench module discovery independent of command execution", () => {
    const allowed = new Set([
      "workbench/pipeline-module.js",
      "cli/cli-pipeline-command-contract.js",
      "utilities/pipeline-command-marker.js",
    ]);
    for (const file of reachableFiles(["workbench/pipeline-module.js"])) {
      const name = relative(dist, file).split(sep).join("/");
      expect(allowed.has(name), `Workbench module discovery reaches ${name}`).toBe(true);
    }
  });

  it("confines cloudflare:workers to the Cloudflare entrypoint", () => {
    for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (!name.endsWith(".js")) continue;
      const specifiers = externalSpecifiers(resolve(dist, name));
      if (specifiers.some((specifier) => specifier.startsWith("cloudflare:"))) {
        expect(name.split(sep).join("/"), `${name} imports a Cloudflare platform module`).toBe(
          "cloudflare/cloudflare.js"
        );
      }
    }
    expect(readFileSync(resolve(dist, "cloudflare/cloudflare.d.ts"), "utf8")).not.toMatch(
      /cloudflare:|@cloudflare\//
    );
  });

  it("keeps the Cloudflare cache entrypoint loadable outside workerd", () => {
    for (const file of reachableFiles(["cloudflare/cloudflare-cache.js"])) {
      for (const specifier of externalSpecifiers(file)) {
        expect(specifier, `${relative(dist, file)} imports ${specifier}`).not.toMatch(
          /^cloudflare:/
        );
      }
    }
    expect(readFileSync(resolve(dist, "cloudflare/cloudflare-cache.d.ts"), "utf8")).not.toMatch(
      /cloudflare:|@cloudflare\//
    );
  });

  it("keeps CLI authoring independent of workbench, storage and Studio", () => {
    for (const file of reachableFiles(["cli/cli.js"])) {
      expect(
        ["cli", "core", "node", "reporter", "tracing", "utilities"].includes(moduleName(file)),
        `CLI entrypoint reaches operational module: ${relative(dist, file)}`
      ).toBe(true);
    }
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
    const tracingInternals = new Set([
      "tracing/tracing.js",
      "tracing/artifact-metadata.js",
      "tracing/graph-metadata.js",
      "tracing/tracing-codec.js",
      "tracing/tracing-constants.js",
      "tracing/tracing-internal.js",
      "tracing/tracing-schema.js",
      "tracing/trace-exporter-error.js",
      "tracing/wire-schema.js",
    ]);
    for (const file of reachableFiles(["core/pipeline.js"])) {
      const name = relative(dist, file).split(sep).join("/");
      expect(
        ["core", "utilities"].includes(moduleName(file)) || tracingInternals.has(name),
        `Root entrypoint reaches optional module: ${name}`
      ).toBe(true);
    }
  });
});
