import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject } from "../../utilities/canonical-json.js";
import { normalizeRemoteOrigin } from "../workbench-remote-io.js";

const REMOTE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export type WorkerRemote = {
  provider: "cloudflare";
  host: string;
  projectId?: string;
  access: "user" | "service";
};
export type RemoteDestination =
  | WorkerRemote
  | { provider: "tubeless-cloud"; host: string; workspaceId: string };

export function remoteDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const root = env.XDG_CONFIG_HOME;
  return join(root && isAbsolute(root) ? root : join(homedir(), ".config"), "tubeless", "remotes");
}

export function remoteName(value: string): string {
  if (!REMOTE_NAME.test(value))
    throw new Error(
      "Use 1–63 lowercase letters, digits, hyphens or underscores for a remote name."
    );
  return value;
}

export function defaultRemoteName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 63)
      .replace(/^-+|-+$/g, "") || "remote"
  );
}

export async function readRemote(directory: string, name: string): Promise<RemoteDestination> {
  const file = join(directory, remoteName(name) + ".json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Remote "${name}" is not configured. Run tubeless remote connect.`);
    throw new Error(`Could not read remote "${name}" from ${file}.`, { cause: error });
  }
  if (isJsonObject(raw) && raw.version === 1 && typeof raw.host === "string") {
    const host = normalizeRemoteOrigin(raw.host, "Saved remote host");
    if (
      raw.provider === "tubeless-cloud" &&
      typeof raw.workspaceId === "string" &&
      raw.workspaceId.trim()
    )
      return { provider: raw.provider, host, workspaceId: raw.workspaceId };
    if (
      raw.provider === "cloudflare" &&
      (raw.access === "service" || raw.access === "user") &&
      (raw.projectId === undefined || typeof raw.projectId === "string")
    )
      return { provider: raw.provider, host, projectId: raw.projectId, access: raw.access };
  }
  throw new Error(`Invalid remote configuration in ${file}.`);
}

export async function remoteNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .filter((name) => REMOTE_NAME.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveRemote(
  directory: string,
  name: string,
  remote: RemoteDestination
): Promise<void> {
  const file = join(directory, remoteName(name) + ".json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = join(directory, `.${crypto.randomUUID()}.tmp`);
  await writeFile(pending, JSON.stringify({ version: 1, ...remote }, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(pending, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (isDeepStrictEqual(await readRemote(directory, name), remote)) return;
    throw new Error(`Remote "${name}" already exists. Choose another --name.`);
  } finally {
    await unlink(pending);
  }
}

export async function selectRemote(directory: string, name?: string): Promise<RemoteDestination> {
  if (name !== undefined) return readRemote(directory, name);
  const names = await remoteNames(directory);
  if (names.length === 1) return readRemote(directory, names[0]);
  throw new Error(
    names.length
      ? `Choose a saved remote with --remote <name>: ${names.join(", ")}.`
      : "Pass --host <origin> or set up a named remote with tubeless remote connect."
  );
}
