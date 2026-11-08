import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, "scripts/check-release-commit.sh");
const workflowPath = join(root, ".github/workflows/publish.yml");
const directories: string[] = [];

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  run?: string;
}
interface WorkflowJob {
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}
const workflow = JSON.parse(
  execFileSync(
    "bun",
    [
      "-e",
      "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(Bun.argv.at(-1)).text())))",
      workflowPath,
    ],
    { encoding: "utf8" }
  )
) as { jobs: Record<string, WorkflowJob> };

function step(job: string, name: string): WorkflowStep {
  const found = workflow.jobs[job]!.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${job} step: ${name}`);
  return found;
}
function checkout(job: string): WorkflowStep {
  return workflow.jobs[job]!.steps.find((candidate) =>
    candidate.uses?.startsWith("actions/checkout@")
  )!;
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture(
  version = "1.0.0",
  tagKind: "annotated" | "lightweight" | "none" = "annotated"
) {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-release-commit-"));
  directories.push(directory);
  const repo = join(directory, "repo");
  const remote = join(directory, "remote.git");
  const output = join(directory, "outputs");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(remote);
  await copyFile(
    join(root, "scripts/check-release-version.sh"),
    join(repo, "scripts/check-release-version.sh")
  );
  await copyFile(guard, join(repo, "scripts/check-release-commit.sh"));
  await writeFile(join(repo, "package.json"), JSON.stringify({ version }));
  await writeFile(output, "");
  git(remote, ["init", "--bare"]);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "Release candidate"]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const tag = `v${version}`;
  if (tagKind === "annotated") git(repo, ["tag", "-a", tag, "-m", tag]);
  if (tagKind === "lightweight") git(repo, ["tag", tag]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  if (tagKind !== "none") git(repo, ["push", "origin", tag]);
  return { repo, remote, output, commit, tag };
}

function runStep(run: string, repo: string, output: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", run], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF: "refs/heads/main", GITHUB_OUTPUT: output, ...env },
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

// Creates real git repositories; allow for loaded machines.
describe("release commit guard", { timeout: 30_000 }, () => {
  it.each(["annotated", "lightweight"] as const)(
    "resolves a matching %s tag without mutation",
    async (kind) => {
      const { repo, tag, commit } = await fixture("1.0.0", kind);
      const result = spawnSync("bash", [guard, tag], { cwd: repo, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(commit);
      expect(git(repo, ["status", "--porcelain"])).toBe("");
      expect(git(repo, ["rev-parse", `${tag}^{commit}`])).toBe(commit);
    }
  );

  it("rejects a missing tag without changing the checkout", async () => {
    const { repo, commit } = await fixture();
    const result = spawnSync("bash", [guard, "v9.0.0"], { cwd: repo, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Release tag v9.0.0 does not exist");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(commit);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});

// Creates real git repositories; allow for loaded machines.
describe("publish workflow release identity", { timeout: 30_000 }, () => {
  it("rejects a fresh manual dispatch when main advanced beyond an unpublished tag", async () => {
    const { repo, remote, output, tag, commit } = await fixture();
    await writeFile(join(repo, "later.txt"), "Different source, unchanged package version\n");
    git(repo, ["add", "later.txt"]);
    git(repo, ["commit", "-m", "Advance main"]);
    git(repo, ["push", "origin", "main"]);
    const advanced = git(repo, ["rev-parse", "HEAD"]);
    const result = runStep(step("cut", "Cut version tag").run!, repo, output);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain("does not match HEAD");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(advanced);
    expect(git(remote, ["rev-parse", `${tag}^{commit}`])).toBe(commit);
    expect(await readFile(output, "utf8")).toBe("");
  });

  it.each(["1.0.0", "1.1.0-rc.1"])(
    "exports the matching tag and immutable commit for %s retries",
    async (version) => {
      const { repo, output, tag, commit } = await fixture(version);
      const result = runStep(step("cut", "Cut version tag").run!, repo, output);
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(output, "utf8")).toBe(`tag=${tag}\ncommit=${commit}\n`);
    }
  );

  it("exports the immutable commit when creating a new tag", async () => {
    const { repo, remote, output, tag, commit } = await fixture("1.2.0", "none");
    const result = runStep(step("cut", "Cut version tag").run!, repo, output);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(output, "utf8")).toBe(`tag=${tag}\ncommit=${commit}\n`);
    expect(git(remote, ["rev-parse", `${tag}^{commit}`])).toBe(commit);
  });

  it("checks package and commit identity on both dispatch and tag-push publication", async () => {
    const validate = step("publish", "Require release tag to match package and commit");
    expect(validate).not.toHaveProperty("if");
    for (const ref of ["refs/heads/main", "refs/tags/v1.0.0"]) {
      const { repo, output, tag, commit } = await fixture();
      const result = runStep(validate.run!, repo, output, { GITHUB_REF: ref, RELEASE_TAG: tag });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(output, "utf8")).toBe(`tag=${tag}\ncommit=${commit}\n`);
      await writeFile(output, "");
      await writeFile(join(repo, "later.txt"), "Different source, unchanged package version\n");
      git(repo, ["add", "later.txt"]);
      git(repo, ["commit", "-m", "Advance checkout"]);
      const wrongCommit = runStep(validate.run!, repo, output, {
        GITHUB_REF: ref,
        RELEASE_TAG: tag,
      });
      expect(wrongCommit.status).not.toBe(0);
      expect(wrongCommit.stderr).toContain("does not match HEAD");
      expect(await readFile(output, "utf8")).toBe("");
      await writeFile(join(repo, "package.json"), JSON.stringify({ version: "2.0.0" }));
      const mismatch = runStep(validate.run!, repo, output, { GITHUB_REF: ref, RELEASE_TAG: tag });
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain("does not match package.json");
    }
  });

  it("propagates immutable identity through publication and GitHub release jobs", () => {
    expect(workflow.jobs.cut!.outputs).toEqual({
      tag: "${{ steps.release.outputs.tag }}",
      commit: "${{ steps.release.outputs.commit }}",
    });
    expect(checkout("cut").with?.ref).toBe("${{ github.sha }}");
    expect(checkout("publish").with?.ref).toBe("${{ needs.cut.outputs.commit || github.sha }}");
    expect(workflow.jobs.publish!.outputs).toEqual({
      tag: "${{ steps.release.outputs.tag }}",
      commit: "${{ steps.release.outputs.commit }}",
    });
    expect(checkout("github-release").with?.ref).toBe("${{ needs.publish.outputs.commit }}");
    expect(step("github-release", "Publish GitHub Release").env?.RELEASE_TAG).toBe(
      "${{ needs.publish.outputs.tag }}"
    );
  });
});
