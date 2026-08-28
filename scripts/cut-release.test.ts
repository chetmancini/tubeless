import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cutRelease = join(scriptsDir, "cut-release.sh");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function git(cwd: string, args: string[]) {
  const result = run("git", args, cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function writePackage(cwd: string, version: string) {
  writeFileSync(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "tubeless", private: true, version }, null, 2)}\n`
  );
}

function packageVersion(cwd: string) {
  return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
}

function setupRepo(version = "0.1.0", tag = "v0.1.0") {
  const dir = mkdtempSync(join(tmpdir(), "cut-release-"));
  const remote = mkdtempSync(join(tmpdir(), "cut-release-remote-"));
  temps.push(dir, remote);

  run("git", ["init", "--bare"], remote);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Release Test"]);
  git(dir, ["config", "user.email", "release@example.com"]);
  writePackage(dir, version);
  git(dir, ["add", "package.json"]);
  git(dir, ["commit", "-m", "Initial version"]);
  if (tag) {
    git(dir, ["tag", "-a", tag, "-m", tag]);
  }
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-u", "origin", "main"]);
  if (tag) {
    git(dir, ["push", "origin", tag]);
  }
  return dir;
}

function release(cwd: string, env: NodeJS.ProcessEnv = {}) {
  return run("bash", [cutRelease], cwd, {
    RELEASE_ROOT: cwd,
    SKIP_CHECK: "1",
    EDIT: "0",
    WATCH: "0",
    NOTES: "test notes",
    PUSH: "0",
    ...env,
  });
}

describe("cut-release version bump", () => {
  it("bumps package.json, commits, and tags without pushing when PUSH=0", () => {
    const dir = setupRepo();
    const before = git(dir, ["rev-parse", "HEAD"]);

    const result = release(dir);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(packageVersion(dir)).toBe("0.1.1");
    expect(git(dir, ["log", "-1", "--pretty=%s"])).toBe("Bump version to 0.1.1.");
    expect(git(dir, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(git(dir, ["tag", "-l", "v0.1.1"])).toBe("v0.1.1");
    expect(git(dir, ["rev-parse", "origin/main"])).toBe(before);
    expect(result.stdout).toContain("git push origin main");
    expect(result.stdout).toContain("git push origin v0.1.1");
  });

  it("tags an already-bumped package.json without committing", () => {
    const dir = setupRepo();
    writePackage(dir, "0.1.1");
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-m", "Prepare 0.1.1"]);
    git(dir, ["push", "origin", "main"]);
    const before = git(dir, ["rev-parse", "HEAD"]);

    const result = release(dir);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(packageVersion(dir)).toBe("0.1.1");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(dir, ["log", "-1", "--pretty=%s"])).toBe("Prepare 0.1.1");
    expect(git(dir, ["tag", "-l", "v0.1.1"])).toBe("v0.1.1");
    expect(result.stdout).not.toContain("git push origin main");
    expect(result.stdout).toContain("git push origin v0.1.1");
  });

  it("stops before writing when DRY=1", () => {
    const dir = setupRepo();
    const before = git(dir, ["rev-parse", "HEAD"]);

    const result = release(dir, { DRY: "1" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(packageVersion(dir)).toBe("0.1.0");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(dir, ["tag", "-l", "v0.1.1"])).toBe("");
    expect(result.stdout).toMatch(/0\.1\.1/);
  });

  it("honors BUMP=minor", () => {
    const dir = setupRepo();
    const result = release(dir, { BUMP: "minor" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(packageVersion(dir)).toBe("0.2.0");
  });

  it("honors BUMP=prerelease", () => {
    const dir = setupRepo();
    const result = release(dir, { BUMP: "prerelease" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(packageVersion(dir)).toBe("0.1.1-rc.0");
  });

  it("honors an explicit VERSION", () => {
    const dir = setupRepo();
    const result = release(dir, { VERSION: "0.2.0-rc.1" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(packageVersion(dir)).toBe("0.2.0-rc.1");
  });

  it("writes the version and leaves it uncommitted when check fails", () => {
    const dir = setupRepo();
    writeFileSync(join(dir, "Makefile"), "check:\n\t@echo failing check >&2; exit 1\n");
    git(dir, ["add", "Makefile"]);
    git(dir, ["commit", "-m", "Failing check"]);
    git(dir, ["push", "origin", "main"]);
    const before = git(dir, ["rev-parse", "HEAD"]);

    const result = release(dir, { SKIP_CHECK: "" });
    expect(result.status).not.toBe(0);
    expect(packageVersion(dir)).toBe("0.1.1");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(dir, ["tag", "-l", "v0.1.1"])).toBe("");
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/git checkout -- package\.json/);
  });
});
