import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { summarizeApiReportDiff } from "./summarize-api-report-diff.mjs";

const scriptPath = fileURLToPath(new URL("./summarize-api-report-diff.mjs", import.meta.url));

function report(modules: Array<Record<string, unknown>>, schemaVersion = 1) {
  return { schemaVersion, packageName: "tubeless", modules };
}

function module(
  specifier: string,
  sha256: string,
  exports: string[]
): { specifier: string; declaration: string; sha256: string; exports: string[] } {
  return {
    specifier,
    declaration: `./dist/${specifier}.d.ts`,
    sha256,
    exports,
  };
}

describe("summarizeApiReportDiff", () => {
  it("reports unchanged when reports are identical", () => {
    const base = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const summary = summarizeApiReportDiff(base, structuredClone(base));
    expect(summary.changed).toBe(false);
    expect(summary.markdown).toContain("# Public API report");
    expect(summary.markdown).toContain("The public API report is unchanged.");
    expect(summary.markdown).not.toContain("Review this before merge.");
  });

  it("lists added exports", () => {
    const base = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const head = report([
      module("tubeless", "bbbbbbbbbbbbbbbb", ["createSteps", "definePipeline"]),
    ]);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.changed).toBe(true);
    expect(summary.markdown).toContain("Review this before merge.");
    expect(summary.markdown).toContain("`tubeless`");
    expect(summary.markdown).toContain("added: `definePipeline`");
    expect(summary.markdown).toContain("`aaaaaaaa` → `bbbbbbbb`");
  });

  it("lists removed exports", () => {
    const base = report([
      module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps", "definePipeline"]),
    ]);
    const head = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.changed).toBe(true);
    expect(summary.markdown).toContain("removed: `definePipeline`");
    expect(summary.markdown).not.toContain("hash:");
  });

  it("notes changed declarations when export names are unchanged", () => {
    const base = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const head = report([module("tubeless", "bbbbbbbbbbbbbbbb", ["createSteps"])]);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.changed).toBe(true);
    expect(summary.markdown).toContain("hash changed");
    expect(summary.markdown).toContain(
      "public declarations changed (comments and whitespace are ignored); exported names are unchanged. Check for signature changes."
    );
    expect(summary.markdown).toContain("`aaaaaaaa` → `bbbbbbbb`");
  });

  it("does not compare hashes across report schema versions", () => {
    const base = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])], 1);
    const head = report([module("tubeless", "bbbbbbbbbbbbbbbb", ["createSteps"])], 2);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.changed).toBe(false);
    expect(summary.markdown).toContain(
      "Surface hashes are not comparable across report schema versions (`1` → `2`); only exported names were compared."
    );
    expect(summary.markdown).not.toContain("hash:");
    expect(summary.markdown).toContain("The public API report is unchanged.");
  });

  it("reports removals when schema versions differ", () => {
    const base = report(
      [module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps", "definePipeline"])],
      1
    );
    const head = report([module("tubeless", "bbbbbbbbbbbbbbbb", ["createSteps"])], 2);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.changed).toBe(true);
    expect(summary.markdown).toContain("not comparable across report schema versions");
    expect(summary.markdown).toContain("removed: `definePipeline`");
    expect(summary.removed).toEqual(["tubeless: definePipeline"]);
  });

  it("collects removed exports and entrypoints", () => {
    const base = report([
      module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps", "definePipeline"]),
      module("tubeless/project", "cccccccccccccccc", ["compilePipelineDocument"]),
    ]);
    const head = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.removed).toHaveLength(3);
    expect(summary.removed).toContain("tubeless: definePipeline");
    expect(summary.removed).toContain("tubeless/project: (entrypoint)");
    expect(summary.removed).toContain("tubeless/project: compilePipelineDocument");

    expect(summarizeApiReportDiff(base, structuredClone(base)).removed).toEqual([]);
  });

  it("reports added and removed specifiers", () => {
    const base = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const head = report([
      module("tubeless/project", "cccccccccccccccc", ["compilePipelineDocument"]),
    ]);
    const summary = summarizeApiReportDiff(base, head);
    expect(summary.changed).toBe(true);
    expect(summary.markdown).toContain("`tubeless` (removed)");
    expect(summary.markdown).toContain("removed exports: `createSteps`");
    expect(summary.markdown).toContain("`tubeless/project` (added)");
    expect(summary.markdown).toContain("added exports: `compilePipelineDocument`");
  });

  it("throws when a report is missing modules", () => {
    expect(() => summarizeApiReportDiff({}, report([]))).toThrow(/modules array/i);
    expect(() => summarizeApiReportDiff(report([]), { modules: null })).toThrow(/modules array/i);
  });
});

describe("summarize-api-report-diff CLI", () => {
  function runCli(args: string[], base: unknown, head: unknown) {
    const root = mkdtempSync(join(tmpdir(), "tubeless-api-diff-"));
    const basePath = join(root, "base.json");
    const headPath = join(root, "head.json");
    writeFileSync(basePath, `${JSON.stringify(base, null, 2)}\n`);
    writeFileSync(headPath, `${JSON.stringify(head, null, 2)}\n`);
    return spawnSync(
      process.execPath,
      [scriptPath, ...args, "--base-file", basePath, "--head-file", headPath],
      { encoding: "utf8" }
    );
  }

  it("exits 0 for --base-file/--head-file", () => {
    const payload = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const result = runCli([], payload, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("The public API report is unchanged.");
  });

  it("prints only removed exports for --removed-only", () => {
    const base = report([
      module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps", "definePipeline"]),
    ]);
    const head = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const result = runCli(["--removed-only"], base, head);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("tubeless: definePipeline\n");
  });

  it("prints nothing for --removed-only when nothing was removed", () => {
    const payload = report([module("tubeless", "aaaaaaaaaaaaaaaa", ["createSteps"])]);
    const result = runCli(["--removed-only"], payload, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
