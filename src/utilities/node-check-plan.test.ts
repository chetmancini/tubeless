import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});

it("decodes transported plans without accepting modified argv or dependencies", () => {
  const plan = resolveNodeCheckPlan(config, manifest);
  expect(decodeNodeCheckPlan(plan)).toEqual(plan);
  const tampered = structuredClone(plan);
  tampered.commands[1].argv = ["publish"];
  expect(decodeNodeCheckPlan(tampered)).toBeUndefined();
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
