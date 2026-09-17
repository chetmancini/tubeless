import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkbenchCli } from "./workbench.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(source: string, extension = "yaml") {
  const directory = mkdtempSync(join(tmpdir(), "tubeless-validate-"));
  directories.push(directory);
  const file = join(directory, `pipelines.${extension}`);
  writeFileSync(file, source);
  return file;
}

function validate(file: string) {
  return spawnSync("bun", ["dist/workbench/workbench-bin.js", "validate", "--json", file], {
    encoding: "utf8",
  });
}

describe("tubeless validate", () => {
  it.each(["examples/declarative/pipelines.yaml", "examples/declarative/peloton.yaml"])(
    "validates the real %s document",
    (file) => {
      const result = validate(file);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        version: 1,
        metadata: { name: expect.any(String) },
      });
    }
  );

  it("checks JSON without resolving handler names or schema URLs", () => {
    const result = validate(
      fixture(
        JSON.stringify({
          $schema: "https://example.invalid/never-fetch.json",
          version: 1,
          pipelines: {
            example: {
              steps: [{ id: "work", run: "./must-not-import.ts" }],
              finalize: { run: "not-registered" },
            },
          },
        }),
        "json"
      )
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, pipelines: ["example"] });
  });

  it("returns a document path and validation exit code for an invalid field", () => {
    const result = validate(
      fixture(
        "version: 1\nmetadata:\n  date: '2026-02-30'\npipelines:\n  example:\n    steps: [{id: work, run: work}]\n    finalize: {run: done}\n"
      )
    );
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "TUBELESS_DOCUMENT_INVALID", path: "$.metadata.date" },
    });
  });

  it.each([
    ["pipelines: [", "yaml"],
    ["{", "json"],
  ])("reports parser failures as structured errors", (source, extension) => {
    const result = validate(fixture(source, extension));
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.any(String) },
    });
  });

  it("rejects executable files without importing them", () => {
    const result = validate(fixture('throw new Error("IMPORTED");', "ts"));
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("Expected a .yaml, .yml, or .json document");
    expect(result.stdout).not.toContain("IMPORTED");
  });

  it("uses the common help and usage handling", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      cwd: process.cwd(),
      stdout: {
        write: (value: string) => {
          output.push(value);
        },
      },
      stderr: {
        write: (value: string) => {
          errors.push(value);
        },
      },
    };
    expect(await runWorkbenchCli(["validate", "--help"], io)).toBe(0);
    expect(output.join("")).toContain("without importing handlers");
    expect(await runWorkbenchCli(["validate"], io)).toBe(1);
    expect(errors.join("")).toContain("Pass exactly one");
  });
});
