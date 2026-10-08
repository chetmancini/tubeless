import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { isCloudObject } from "./cloud-protocol.js";

const DEFAULT_CLOUD_HOST = "https://cloud.tubeless.io";
export const CLOUD_FILE_LIMIT = 64 * 1024;
const execFileAsync = promisify(execFile);

export interface CloudProjectConfig {
  version: 1;
  host: string;
  workspaceId: string;
  repositoryId: string;
  repository: string;
  branch: string;
}

export interface CloudProjectLink {
  root: string;
  config: CloudProjectConfig;
}

/** Normalize a service origin without allowing credential, path or redirect ambiguity. */
export function normalizeCloudHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud host must be an HTTPS origin, for example https://cloud.tubeless.io.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    !/^https?:\/\/[^/?#@]+\/?$/i.test(value) ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "Cloud host must be an HTTPS origin without credentials, path, query or fragment. HTTP is allowed only for localhost or loopback development."
    );
  }
  return url.origin;
}

export function resolveCloudHost(explicitHost?: string, config?: CloudProjectConfig): string {
  return normalizeCloudHost(explicitHost ?? config?.host ?? DEFAULT_CLOUD_HOST);
}

/** Git root discovery uses an argv-only read operation; no project code or hooks run. */
export async function findGitRoot(
  cwd: string,
  options: { required?: boolean } = {}
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8192,
      timeout: 5000,
    });
    const root = stdout.trim();
    if (!root || !path.isAbsolute(root)) throw new Error("Invalid Git root");
    return path.resolve(root);
  } catch {
    if (options.required) {
      throw new Error(
        "This command requires a Git checkout. Use cloud run --id with --workspace for remote-only execution."
      );
    }
    return undefined;
  }
}

/** Read at most 64 KB, rejecting nonregular files and oversized data before parsing. */
export async function readBoundedCloudFile(filePath: string): Promise<string> {
  const stat = await lstat(filePath);
  if (!stat.isFile()) throw new Error("Cloud JSON must be a regular file.");
  if (stat.size > CLOUD_FILE_LIMIT) throw new Error("Cloud JSON exceeds the 64 KB limit.");
  const file = await open(filePath, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > CLOUD_FILE_LIMIT) {
      throw new Error("Cloud JSON exceeds the 64 KB limit or is not a regular file.");
    }
    const buffer = Buffer.alloc(CLOUD_FILE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > CLOUD_FILE_LIMIT) throw new Error("Cloud JSON exceeds the 64 KB limit.");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    await file.close();
  }
}

function nonblank(value: unknown, limit = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseCloudProjectConfig(value: unknown): CloudProjectConfig {
  if (!isCloudObject(value) || value.version !== 1) {
    throw new Error(
      "Invalid or unsupported .tubeless/cloud.json. Repair it before linking again; the file was preserved."
    );
  }
  const allowed = ["version", "host", "workspaceId", "repositoryId", "repository", "branch"];
  if (
    Object.keys(value).some((field) => !allowed.includes(field)) ||
    !nonblank(value.host, 2048) ||
    !nonblank(value.workspaceId) ||
    !nonblank(value.repositoryId) ||
    !nonblank(value.repository) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    !nonblank(value.branch, 1024)
  ) {
    throw new Error(
      "Invalid .tubeless/cloud.json. Repair it before linking again; the file was preserved."
    );
  }
  return {
    version: 1,
    host: normalizeCloudHost(value.host),
    workspaceId: value.workspaceId,
    repositoryId: value.repositoryId,
    repository: value.repository,
    branch: value.branch,
  };
}

function isMissing(error: unknown): boolean {
  return isCloudObject(error) && error.code === "ENOENT";
}

async function readConfigAtRoot(root: string): Promise<CloudProjectConfig | undefined> {
  const filePath = path.join(root, ".tubeless", "cloud.json");
  let source: string;
  try {
    source = await readBoundedCloudFile(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(
      "Cannot read .tubeless/cloud.json. Repair the existing file before linking again; it was preserved."
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error(
      "Malformed .tubeless/cloud.json. Repair it before linking again; the file was preserved."
    );
  }
  return parseCloudProjectConfig(value);
}

export async function readCloudConfig(cwd: string): Promise<CloudProjectLink | undefined> {
  const root = await findGitRoot(cwd);
  if (!root) return undefined;
  const config = await readConfigAtRoot(root);
  return config ? { root, config } : undefined;
}

/** Replace only the validated Cloud link atomically; preserve unrelated .tubeless files. */
export async function writeCloudConfig(root: string, config: CloudProjectConfig): Promise<void> {
  const validated = parseCloudProjectConfig(config);
  const directory = path.join(root, ".tubeless");
  const filePath = path.join(directory, "cloud.json");
  await readConfigAtRoot(root);
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(
      "The .tubeless directory must be a regular directory; the existing link was preserved."
    );
  }
  const temporaryPath = path.join(directory, `.cloud-${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    // Recheck after writing so an invalid link created during the write is preserved.
    await readConfigAtRoot(root);
    await rename(temporaryPath, filePath);
  } finally {
    await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

/** Resolve a positional path from invocation cwd without reading or evaluating its module. */
export function normalizeCloudSourcePath(root: string, cwd: string, selector: string): string {
  if (
    !nonblank(selector, 4096) ||
    path.isAbsolute(selector) ||
    /^[A-Za-z]:[\\/]/.test(selector) ||
    selector.includes("\\")
  ) {
    throw new Error(
      "Cloud pipeline path must be a relative path inside the linked Git repository."
    );
  }
  // Git returns a physical root while callers may use /tmp, /var or a symlinked cwd.
  // Canonicalize only the existing directories; the source file need not exist.
  const relative = path.relative(realpathSync(root), path.resolve(realpathSync(cwd), selector));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Cloud pipeline path escapes the linked Git repository.");
  }
  const normalized = relative.split(path.sep).join("/");
  validateCloudPathGrammar(normalized, "pipeline");
  return normalized;
}

function validateCloudPathGrammar(value: string, source: "pipeline" | "registry"): void {
  if (value.length > 200 || !/^[\w./-]+$/.test(value)) {
    throw new Error(
      `Cloud ${source} path must use only ASCII letters, digits, underscores, dots, hyphens and slashes, with at most 200 characters. Choose a supported repository path before adding or running it.`
    );
  }
}

/** Registry selectors already name a repository-relative source, never a local absolute path. */
export function normalizeCloudRemotePath(selector: string): string {
  if (
    !nonblank(selector, 4096) ||
    selector.includes("\\") ||
    selector.startsWith("/") ||
    /^[A-Za-z]:/.test(selector) ||
    selector.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Cloud registry path must be a traversal-free repository-relative path.");
  }
  validateCloudPathGrammar(selector, "registry");
  return selector;
}

/** Extract only repository identity, never include a remote's userinfo in diagnostics. */
export function githubRepositoryFromRemote(remote: string): string | undefined {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+?))(?:\.git)?$/.exec(remote);
  if (scp) return scp[1];
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    !["https:", "ssh:"].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    return undefined;
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : undefined;
}

export async function gitHubRepositories(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "-v"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 5000,
    });
    return [
      ...new Set(
        stdout.split("\n").flatMap((line) => {
          const remote = line.trim().split(/\s+/)[1];
          const repository = remote ? githubRepositoryFromRemote(remote) : undefined;
          return repository ? [repository] : [];
        })
      ),
    ];
  } catch {
    throw new Error(
      "Cannot read Git remotes. Select the connected repository explicitly with --repository."
    );
  }
}
