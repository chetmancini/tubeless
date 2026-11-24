import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveNodeCheckPlan, decodeNodeCheckPlan } from "./node-check-plan.js";
const fixture = new URL("../../scripts/fixtures/node-check/", import.meta.url);
const config = JSON.parse(readFileSync(new URL("tubeless.check.json", fixture), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("package.json", fixture), "utf8"));
describe("portable Node recipe resolution", () => {
  it("exposes installation, script bodies, dependencies and structured reporter argv", () => {
    expect(resolveNodeCheckPlan(config, manifest)).toMatchObject({
      version: 1,
      recipe: "node-check-v1",
      commands: [
        { id: "install", argv: ["bun", "install", "--frozen-lockfile"] },
        {
          id: "types",
          dependsOn: ["install"],
          script: { name: "types", body: "node --check app.js" },
        },
        {
          id: "test",
          dependsOn: ["install", "types"],
          report: { adapter: "vitest", path: ".tubeless-reports/vitest.json" },
        },
      ],
    });
  });
  it.each([
    { ...config, version: 2 },
    { ...config, toolchain: { node: "22", bun: "1.4.4" } },
    { ...config, checks: [] },
    { ...config, maxConcurrency: null },
    { ...config, checks: [{ id: "x", script: "types", timeoutMs: null }] },
    { ...config, checks: [{ id: "x", script: "types", dependsOn: null }] },
    { ...config, commands: ["arbitrary"] },
    { ...config, checks: [{ id: "x", script: "missing" }] },
    { ...config, checks: [{ id: "x", script: "types", dependsOn: ["x"] }] },
    { ...config, checks: [{ id: "x", script: "types", dependsOn: ["absent"] }] },
    { ...config, checks: [{ id: "x", vitest: { report: "../other.json" } }] },
    {
      ...config,
      checks: [{ id: "x", script: "types", vitest: { report: ".tubeless-reports/a.json" } }],
    },
  ])("rejects unsupported or ambiguous configuration %#", (value) => {
    expect(() => resolveNodeCheckPlan(value, manifest)).toThrow();
  });
  it.each(["--help", "--version", "-h", "-"])(
    "rejects option-like script %s during resolution and transported-plan decoding",
    (name) => {
      expect(() =>
        resolveNodeCheckPlan(
          { ...config, checks: [{ id: "types", script: name }] },
          { ...manifest, scripts: { [name]: "exit 9" } }
        )
      ).toThrow("invalid package script");
      const plan = resolveNodeCheckPlan(config, manifest);
      const command = plan.commands[1];
      if (command.kind !== "script") throw new Error("Expected script fixture.");
      command.script = { name, body: "exit 9" };
      command.argv = ["bun", "run", "--silent", name];
      expect(decodeNodeCheckPlan(plan)).toBeUndefined();
    }
  );
  it("rejects report paths that collide on case-insensitive hosts", () => {
    const configuration = {
      ...config,
      maxConcurrency: 2,
      checks: [
        { id: "a", vitest: { report: ".tubeless-reports/Test.json" } },
        { id: "b", vitest: { report: ".tubeless-reports/other.json" } },
      ],
    };
    const transported = resolveNodeCheckPlan(configuration, manifest);
    configuration.checks[1].vitest.report = ".tubeless-reports/test.json";
    expect(() => resolveNodeCheckPlan(configuration, manifest)).toThrow("unique Vitest reports");
    const command = transported.commands[2];
    if (command.kind !== "vitest") throw new Error("Expected Vitest fixture.");
    command.report.path = ".tubeless-reports/test.json";
    command.argv = command.argv.map((arg) =>
      arg.startsWith("--outputFile=") ? `--outputFile=${command.report.path}` : arg
    );
    expect(decodeNodeCheckPlan(transported)).toBeUndefined();
  });
});

it("decodes transported plans without accepting modified argv or dependencies", () => {
  const plan = resolveNodeCheckPlan(config, manifest);
  expect(decodeNodeCheckPlan(plan)).toEqual(plan);
  const tampered = structuredClone(plan);
  tampered.commands[1].argv = ["publish"];
  expect(decodeNodeCheckPlan(tampered)).toBeUndefined();
});

it("compares transported argv as bounded string arrays without serializing it", () => {
  const plan = resolveNodeCheckPlan(config, manifest);
  const command = plan.commands[0];
  const serialize = vi.fn(() => command.argv);
  const malformed = {
    ...plan,
    commands: [{ ...command, argv: { toJSON: serialize } }, ...plan.commands.slice(1)],
  };
  expect(decodeNodeCheckPlan(malformed)).toBeUndefined();
  expect(serialize).not.toHaveBeenCalled();
});

it("matches the paired Cloud command-plan fixture", () => {
  expect(resolveNodeCheckPlan(config, manifest)).toEqual(
    JSON.parse(
      readFileSync(new URL("../../fixtures/node-check/plan-v1.json", import.meta.url), "utf8")
    )
  );
});

it.each([
  (plan: ReturnType<typeof resolveNodeCheckPlan>) => {
    plan.commands[0].argv = ["publish"];
  },
  (plan: ReturnType<typeof resolveNodeCheckPlan>) => {
    plan.commands[1].dependsOn = [];
  },
  (plan: ReturnType<typeof resolveNodeCheckPlan>) => {
    Object.assign(plan.commands[1], { report: { path: ".tubeless-reports/x.json" } });
  },
  (plan: ReturnType<typeof resolveNodeCheckPlan>) => {
    Object.assign(plan.commands[1], { kind: "arbitrary" });
  },
  (plan: ReturnType<typeof resolveNodeCheckPlan>) => {
    plan.commands.reverse();
  },
])("rejects malformed command variants without synthesizing another configuration", (mutate) => {
  const plan = resolveNodeCheckPlan(config, manifest);
  mutate(plan);
  expect(decodeNodeCheckPlan(plan)).toBeUndefined();
});
