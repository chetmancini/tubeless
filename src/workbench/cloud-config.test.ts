import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOUD_FILE_LIMIT,
  findGitRoot,
  githubRepositoryFromRemote,
  gitHubRepositories,
  normalizeCloudHost,
  normalizeCloudRemotePath,
  normalizeCloudSourcePath,
  readBoundedCloudFile,
  readCloudConfig,
  resolveCloudHost,
  writeCloudConfig,
  type CloudProjectConfig,
} from "./cloud-config.js";
import { execFileAsync } from "./workbench.test-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const config: CloudProjectConfig = {
  version: 1,
  host: "https://cloud.tubeless.io",
  workspaceId: "workspace",
  repositoryId: "repo",
  repository: "owner/project",
  branch: "main",
};

async function fixture(git = true): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-cloud-config-"));
  directories.push(directory);
  if (git) await execFileAsync("git", ["init", "--quiet", directory]);
  return realpath(directory);
}

describe("Cloud origins", () => {
  it("normalizes selected origins and follows explicit/project/default precedence", () => {
    expect(normalizeCloudHost("https://CLOUD.example:443/")).toBe("https://cloud.example");
    expect(normalizeCloudHost("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeCloudHost("http://[::1]:8787/")).toBe("http://[::1]:8787");
    expect(resolveCloudHost()).toBe(config.host);
    expect(resolveCloudHost(undefined, { ...config, host: "https://other.example" })).toBe(
      "https://other.example"
    );
    expect(resolveCloudHost("http://localhost:8787", config)).toBe("http://localhost:8787");
  });

  it("rejects credentials, remote HTTP, paths, queries, fragments and disguised paths", () => {
    for (const host of [
      "https://user:secret@cloud.example",
      "https://@cloud.example",
      "http://cloud.example",
      "https://cloud.example/api",
      "https://cloud.example/x/..",
      "https://cloud.example?",
      "https://cloud.example?token=secret",
      "https://cloud.example#",
      "https://cloud.example/#fragment",
      " https://cloud.example",
      "https://cloud.example\\api",
    ]) {
      expect(() => normalizeCloudHost(host)).toThrow("Cloud host must");
    }
  });
});

describe("Cloud project links", () => {
  it("finds the Git root from a nested cwd and preserves unrelated .tubeless files", async () => {
    const root = await fixture();
    const cwd = path.join(root, "nested", "deep");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(root, ".tubeless"));
    await writeFile(path.join(root, ".tubeless", "unrelated.json"), "preserved");
    await writeCloudConfig(root, config);
    expect(await readCloudConfig(cwd)).toEqual({ root, config });
    expect(await readFile(path.join(root, ".tubeless", "unrelated.json"), "utf8")).toBe(
      "preserved"
    );
    expect((await readdir(path.join(root, ".tubeless"))).sort()).toEqual([
      "cloud.json",
      "unrelated.json",
    ]);
    expect(normalizeCloudSourcePath(root, cwd, "../../pipelines/missing.ts")).toBe(
      "pipelines/missing.ts"
    );
  });

  it("allows remote-only operations outside Git without creating a link", async () => {
    const root = await fixture(false);
    expect(await findGitRoot(root)).toBeUndefined();
    expect(await readCloudConfig(root)).toBeUndefined();
    await expect(findGitRoot(root, { required: true })).rejects.toThrow("remote-only execution");
    expect(await readdir(root)).toEqual([]);
  });

  it("normalizes a symlinked invocation cwd against Git's physical repository root", async () => {
    const root = await fixture();
    const elsewhere = await fixture(false);
    await mkdir(path.join(root, "nested"));
    await symlink(root, path.join(elsewhere, "checkout"));
    const cwd = path.join(elsewhere, "checkout", "nested");
    expect(await findGitRoot(cwd)).toBe(root);
    expect(normalizeCloudSourcePath(root, cwd, "../pipelines/missing.ts")).toBe(
      "pipelines/missing.ts"
    );
  });

  it("preserves malformed, unsupported and oversized existing configurations", async () => {
    const root = await fixture();
    const directory = path.join(root, ".tubeless");
    await mkdir(directory);
    const file = path.join(directory, "cloud.json");
    for (const source of [
      "invalid-json",
      JSON.stringify({ ...config, version: 2 }),
      JSON.stringify({ ...config, token: "must-not-save" }),
      "x".repeat(CLOUD_FILE_LIMIT + 1),
    ]) {
      await writeFile(file, source);
      await expect(readCloudConfig(root)).rejects.toThrow();
      await expect(writeCloudConfig(root, config)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(source);
      expect(await readdir(directory)).toEqual(["cloud.json"]);
    }
  });

  it("leaves a valid link intact when atomic replacement cannot be written", async () => {
    const root = await fixture();
    await writeCloudConfig(root, config);
    const directory = path.join(root, ".tubeless");
    await chmod(directory, 0o500);
    try {
      await expect(writeCloudConfig(root, { ...config, branch: "other" })).rejects.toThrow();
      expect((await readCloudConfig(root))?.config.branch).toBe("main");
      expect(await readdir(directory)).toEqual(["cloud.json"]);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("rejects symlinked links and directories rather than replacing unrelated files", async () => {
    const root = await fixture();
    const elsewhere = await fixture(false);
    await writeFile(path.join(elsewhere, "cloud.json"), JSON.stringify(config));
    await symlink(elsewhere, path.join(root, ".tubeless"));
    await expect(writeCloudConfig(root, { ...config, branch: "other" })).rejects.toThrow(
      "regular directory"
    );
    expect(JSON.parse(await readFile(path.join(elsewhere, "cloud.json"), "utf8"))).toEqual(config);
  });

  it("bounds JSON bytes and rejects special files", async () => {
    const root = await fixture(false);
    const file = path.join(root, "input.json");
    await writeFile(file, "é".repeat(CLOUD_FILE_LIMIT / 2));
    expect((await readBoundedCloudFile(file)).length).toBe(CLOUD_FILE_LIMIT / 2);
    await writeFile(file, "é".repeat(CLOUD_FILE_LIMIT / 2 + 1));
    await expect(readBoundedCloudFile(file)).rejects.toThrow("64 KB");
    await expect(readBoundedCloudFile(root)).rejects.toThrow("regular file");
  });

  it("rejects escaping, absolute and traversal-bearing remote selectors", async () => {
    const root = await fixture();
    for (const source of ["../outside.ts", "/tmp/file.ts", "C:\\file.ts", "sub\\file.ts"]) {
      expect(() => normalizeCloudSourcePath(root, root, source)).toThrow();
    }
    expect(normalizeCloudRemotePath("registries/handlers.ts")).toBe("registries/handlers.ts");
    for (const source of [
      "../file.ts",
      "sub/../file.ts",
      "/file.ts",
      "./file.ts",
      "sub//file.ts",
      "C:/file.ts",
    ]) {
      expect(() => normalizeCloudRemotePath(source)).toThrow("traversal-free");
    }
  });

  it("rejects source and registry paths outside the existing service's ASCII and length limits", async () => {
    const root = await fixture();
    for (const source of [
      "pipelines/order sync.ts",
      "pipelines/café.ts",
      `${"x".repeat(198)}.ts`,
    ]) {
      expect(() => normalizeCloudSourcePath(root, root, source)).toThrow("at most 200 characters");
      expect(() => normalizeCloudRemotePath(source)).toThrow("at most 200 characters");
    }
    const boundary = `${"x".repeat(197)}.ts`;
    expect(boundary.length).toBe(200);
    expect(normalizeCloudSourcePath(root, root, boundary)).toBe(boundary);
    expect(normalizeCloudRemotePath(boundary)).toBe(boundary);
  });
});

describe("GitHub remote identity", () => {
  it("recognizes SSH and HTTPS URLs without exposing embedded credentials", async () => {
    expect(githubRepositoryFromRemote("git@github.com:owner/project.git")).toBe("owner/project");
    expect(githubRepositoryFromRemote("ssh://git@github.com/owner/project.git")).toBe(
      "owner/project"
    );
    expect(githubRepositoryFromRemote("https://username:secret@github.com/owner/project.git")).toBe(
      "owner/project"
    );
    expect(githubRepositoryFromRemote("https://github.example/owner/project.git")).toBeUndefined();
    const root = await fixture();
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "https://username:secret@github.com/owner/project.git"],
      { cwd: root }
    );
    expect(await gitHubRepositories(root)).toEqual(["owner/project"]);
  });
});
