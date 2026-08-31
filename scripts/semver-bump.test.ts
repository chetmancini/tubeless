import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "semver-bump.mjs");

function run(args: string[]) {
  return spawnSync("node", [script, ...args], { encoding: "utf8" });
}

function next(from: string, bump: string) {
  const result = run(["--from", from, "--next", bump]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("semver-bump --next", () => {
  it("bumps a stable version to the next patch", () => {
    expect(next("0.1.0", "patch")).toMatchObject({
      kind: "patch",
      from: "0.1.0",
      to: "0.1.1",
    });
  });

  it("bumps a stable version to the next minor", () => {
    expect(next("0.1.0", "minor").to).toBe("0.2.0");
  });

  it("bumps a stable version to the next major", () => {
    expect(next("0.1.0", "major").to).toBe("1.0.0");
  });

  it("starts a prerelease from stable as the next patch-rc.0", () => {
    expect(next("0.1.0", "prerelease")).toMatchObject({
      kind: "prerelease",
      title: "patch prerelease",
      from: "0.1.0",
      to: "0.1.1-rc.0",
    });
  });

  it("increments an existing rc prerelease", () => {
    expect(next("0.1.1-rc.0", "prerelease").to).toBe("0.1.1-rc.1");
  });

  it("finalizes a prerelease with patch", () => {
    expect(next("0.1.1-rc.0", "patch")).toMatchObject({
      kind: "stable",
      to: "0.1.1",
    });
  });

  it("prints --sh assignments for the computed version", () => {
    const result = run(["--from", "0.1.0", "--next", "patch", "--sh"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("to='0.1.1'");
    expect(result.stdout).toContain("kind='patch'");
  });

  it("rejects an unknown bump kind", () => {
    const result = run(["--from", "0.1.0", "--next", "hotfix"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/hotfix/);
  });

  it("rejects --next together with --to", () => {
    const result = run(["--from", "0.1.0", "--next", "patch", "--to", "0.1.1"]);
    expect(result.status).not.toBe(0);
  });
});

describe("semver-bump --sh", () => {
  function evalSummary(output: string) {
    return spawnSync("sh", ["-c", `eval "$(cat)"; printf %s "$summary"`], {
      encoding: "utf8",
      input: output,
    });
  }

  it("evals patch, minor, and major assignments to the expected kind and summary", () => {
    for (const [to, kind, summary] of [
      ["1.0.1", "patch", "patch (1.0.0 → 1.0.1)"],
      ["1.1.0", "minor", "minor (1.0.0 → 1.1.0)"],
      ["2.0.0", "major", "major (1.0.0 → 2.0.0)"],
    ] as const) {
      const result = run(["--from", "v1.0.0", "--to", to, "--sh"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`kind='${kind}'`);
      const evaled = evalSummary(result.stdout);
      expect(evaled.status, evaled.stderr).toBe(0);
      expect(evaled.stdout).toBe(summary);
    }
  });

  it("round-trips a hostile non-semver --from through sh eval without expansion", () => {
    const tick = "`";
    const hostile = [
      "vnot-semver",
      "$HOME",
      `${tick}printf x${tick}`,
      ["$(", "echo", "y", ")"].join(""),
      "it's",
      '"quoted"',
      ";tail",
    ].join(" ");
    const result = run(["--from", hostile, "--to", "1.0.1", "--sh"]);
    expect(result.status, result.stderr).toBe(0);
    const evaled = evalSummary(result.stdout);
    expect(evaled.status, evaled.stderr).toBe(0);
    expect(evaled.stdout).toBe(`invalid previous tag ${hostile}`);
  });

  it("leaves JSON output unchanged when --sh is absent", () => {
    const result = run(["--from", "v1.0.0", "--to", "1.0.1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      kind: "patch",
      title: "patch",
      summary: "patch (1.0.0 → 1.0.1)",
      from: "1.0.0",
      to: "1.0.1",
    });
  });
});
