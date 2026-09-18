import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function cli(...args: string[]) {
  const result = spawnSync("bun", ["dist/workbench/workbench-bin.js", ...args], {
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status, result.stdout).toBe(0);
  return result.stdout;
}

describe("public YAML recipe", () => {
  const project = ["--project", "examples/catalog/tubeless.project.ts"];

  it("loads real YAML through public package imports and plans registered targets", () => {
    const output = cli("plan", ...project, "yaml-import", "--target", "normalize", "--explain");
    expect(output).toContain("normalize: run");
    expect(output).toContain("normalize-all");
  });

  it("runs two registered pipelines sharing handlers", () => {
    expect(cli("run", ...project, "yaml-import", "--", "--lines", " Alpha , Beta , ")).toContain(
      '["alpha","beta"]'
    );
    expect(cli("run", ...project, "yaml-preview", "--", "--lines", " Alpha , Beta ")).toContain(
      '[" Alpha "," Beta "]'
    );
  });

  it("exposes the normal descriptor and form execution contract used by Studio", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
      import { YamlImportCommand } from "./examples/yaml-pipelines.ts";
      const values = YamlImportCommand.parseValues({ lines: " Alpha , Beta " });
      if (values.kind !== "values") throw new Error("Invalid form values");
      console.log(JSON.stringify(YamlImportCommand.descriptor));
      await YamlImportCommand.execute(values.values);
    `,
      ],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Comma-separated input rows.");
    expect(result.stdout).toContain('["alpha","beta"]');
  });
});
