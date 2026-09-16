import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

it("rejects simultaneous BUMP and VERSION requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-release-"));
  const remote = await mkdtemp(join(tmpdir(), "tubeless-release-remote-"));
  temporaryDirectories.push(directory, remote);
  await mkdir(join(directory, "scripts"));
  await copyFile(
    new URL("./cut-release.sh", import.meta.url),
    join(directory, "scripts/cut-release.sh")
  );
  await writeFile(join(directory, "package.json"), '{"version":"1.0.0"}\n');

  execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: directory });
  execFileSync("git", ["init", "--bare"], { cwd: remote });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: directory });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: directory });

  const result = spawnSync("bash", ["scripts/cut-release.sh"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, BUMP: "minor", VERSION: "2.0.0" },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("use BUMP or VERSION, not both");
});
