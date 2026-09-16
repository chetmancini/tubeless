import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cutRelease = fileURLToPath(new URL("./cut-release.sh", import.meta.url));
const checkReleaseVersion = fileURLToPath(new URL("./check-release-version.sh", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function setupRepo(version = "1.0.0", tag = `v${version}`) {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-release-"));
  const remote = await mkdtemp(join(tmpdir(), "tubeless-release-remote-"));
  temporaryDirectories.push(directory, remote);
  await mkdir(join(directory, "scripts"));
  await Promise.all([
    copyFile(cutRelease, join(directory, "scripts/cut-release.sh")),
    copyFile(checkReleaseVersion, join(directory, "scripts/check-release-version.sh")),
    writeFile(join(directory, "package.json"), `${JSON.stringify({ version })}\n`),
    writeFile(
      join(directory, "Makefile"),
      'check:\n\t@if [ "$${FAIL_CHECK:-}" = "1" ]; then echo "check failed" >&2; exit 1; fi\n'
    ),
  ]);

  execFileSync("git", ["init", "--bare"], { cwd: remote });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["config", "user.name", "Test"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "Initial"]);
  if (tag) git(directory, ["tag", "-a", tag, "-m", tag]);
  git(directory, ["remote", "add", "origin", remote]);
  git(directory, ["push", "-u", "origin", "main"]);
  if (tag) git(directory, ["push", "origin", tag]);
  return { directory, remote };
}

function release(cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["scripts/cut-release.sh"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, BUMP: "", VERSION: "", ...env },
  });
}

async function packageVersion(cwd: string): Promise<string> {
  return JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).version;
}

describe("cut release", { timeout: 30_000 }, () => {
  it.each([
    ["patch", {}, "1.0.1"],
    ["minor", { BUMP: "minor" }, "1.1.0"],
    ["prerelease", { BUMP: "prerelease" }, "1.0.1-rc.0"],
    ["exact version", { VERSION: "1.2.0" }, "1.2.0"],
  ])("cuts and pushes a %s release", async (_name, env, expectedVersion) => {
    const { directory, remote } = await setupRepo();

    const result = release(directory, env);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await packageVersion(directory)).toBe(expectedVersion);
    expect(git(directory, ["log", "-1", "--pretty=%s"])).toBe(
      `Bump version to ${expectedVersion}.`
    );
    expect(git(directory, ["status", "--porcelain"])).toBe("");
    expect(git(directory, ["tag", "-l", `v${expectedVersion}`])).toBe(`v${expectedVersion}`);
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      git(directory, ["rev-parse", "HEAD"])
    );
    expect(git(remote, ["rev-parse", `refs/tags/v${expectedVersion}`])).toBe(
      git(directory, ["rev-parse", `refs/tags/v${expectedVersion}`])
    );
  });

  it("rejects simultaneous BUMP and VERSION requests", async () => {
    const { directory } = await setupRepo();
    const result = release(directory, { BUMP: "minor", VERSION: "2.0.0" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("use BUMP or VERSION, not both");
    expect(await packageVersion(directory)).toBe("1.0.0");
  });

  it("rejects an exact version older than the latest release before mutation", async () => {
    const { directory } = await setupRepo("2.0.0");
    const before = git(directory, ["rev-parse", "HEAD"]);

    const result = release(directory, { VERSION: "1.5.0" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "refusing version 1.5.0; it must be newer than latest release 2.0.0"
    );
    expect(await packageVersion(directory)).toBe("2.0.0");
    expect(git(directory, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(directory, ["status", "--porcelain"])).toBe("");
  });

  it("does not commit, tag, or push when checks fail", async () => {
    const { directory, remote } = await setupRepo();
    const before = git(directory, ["rev-parse", "HEAD"]);

    const result = release(directory, { FAIL_CHECK: "1" });

    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("check failed");
    expect(await packageVersion(directory)).toBe("1.0.1");
    expect(git(directory, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(directory, ["tag", "-l", "v1.0.1"])).toBe("");
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(before);
  });

  it("allows equality only for an existing-tag retry", () => {
    const strict = spawnSync("bash", [checkReleaseVersion, "1.0.0", "1.0.0"], {
      encoding: "utf8",
    });
    const retry = spawnSync("bash", [checkReleaseVersion, "1.0.0", "1.0.0", "newer-or-equal"], {
      encoding: "utf8",
    });

    expect(strict.status).toBe(1);
    expect(retry.status).toBe(0);
  });
});
