import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  digestNodeCheckPlan,
  type ReproductionManifest,
} from "../utilities/reproduction-manifest.js";
import { readNodeCheckPlan } from "./node-check.js";
import { captureCheckProcess, runCheckProcess } from "./process.js";

type Location = { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal };
type PinnedSource = Pick<ReproductionManifest, "source"> & { repository: { fullName: string } };

export async function withReproductionWorkspace<T>(
  signal: AbortSignal,
  use: (location: Location) => Promise<T>
): Promise<T> {
  if (process.platform === "win32") throw new Error("Reproduction requires a POSIX host.");
  // Vitest reports physical paths, so setup and collection must agree on the root.
  const root = await mkdtemp(join(await realpath(tmpdir()), "tubeless-reproduce-"));
  try {
    const cwd = join(root, "source");
    const home = join(root, "home");
    const temp = join(root, "tmp");
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(temp)]);
    const env = {
      PATH: (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => isAbsolute(dir))
        .join(delimiter),
      HOME: home,
      TMPDIR: temp,
      CI: "true",
      CF_SEND_TELEMETRY: "false",
      NO_COLOR: "1",
      GIT_CEILING_DIRECTORIES: root,
    };
    return await use({ cwd, env, signal });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Verify the pinned source and plan. The caller's Git configuration is available only during fetch. */
export async function prepareReproductionPlan(
  { source, repository }: PinnedSource,
  { cwd, env, signal }: Location,
  planDigest: string
) {
  const local = {
    cwd,
    signal,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  };
  const git = async (args: string[], failure: string): Promise<string> => {
    const result = await captureCheckProcess(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.filemode=true",
        "-c",
        "core.ignoreCase=false",
        "-c",
        "core.precomposeUnicode=false",
        "-c",
        "core.protectHFS=true",
        "-c",
        "core.protectNTFS=true",
        ...args,
      ],
      30_000,
      local
    );
    signal.throwIfAborted();
    if (result.status === "spawn-failed") throw new Error("Git is required on PATH.");
    if (result.status !== "exited" || result.exitCode !== 0 || !result.outputComplete)
      throw new Error(failure);
    return result.stdout;
  };

  await git(
    ["init", "-q", "--template=", "--object-format=sha1"],
    "Cannot initialize the temporary Git checkout."
  );
  const fetched = await runCheckProcess(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "http.followRedirects=false",
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--no-write-fetch-head",
      `https://github.com/${repository.fullName}.git`,
      source.commit,
    ],
    120_000,
    {
      cwd,
      signal,
      env: {
        PATH: env.PATH,
        TMPDIR: env.TMPDIR,
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        GIT_ALLOW_PROTOCOL: "https:ssh",
        GIT_TERMINAL_PROMPT: "0",
      },
    }
  );
  signal.throwIfAborted();
  if (fetched.status !== "exited" || fetched.exitCode !== 0)
    throw new Error(
      `Cannot fetch recorded commit ${source.commit}. Check Git access and whether the revision is still available.`
    );
  const identity = await git(
    ["rev-parse", `${source.commit}^{commit}`, `${source.commit}^{tree}`],
    "Cannot read the recorded Git commit and tree."
  );
  const [commit, tree] = identity.split("\n");
  if (commit !== source.commit)
    throw new Error("Fetched Git commit does not match the recorded commit.");
  if (tree !== source.treeSha)
    throw new Error("Fetched Git tree does not match the recorded tree SHA.");

  const modes = await git(
    ["ls-tree", "-r", "--format=%(objectmode)", source.commit],
    "Cannot inspect the recorded Git tree."
  );
  if (modes.split("\n").some((mode) => mode !== "100644" && mode !== "100755"))
    throw new Error("Unsupported Git tree. Reproduction requires regular tracked files.");
  // Reproduce the raw Git blobs even when repository attributes request local conversions.
  await mkdir(join(cwd, ".git", "info"), { recursive: true });
  await writeFile(
    join(cwd, ".git", "info", "attributes"),
    "* -text -eol -ident -filter -working-tree-encoding\n"
  );
  await git(
    ["checkout", "-q", "--detach", "--no-recurse-submodules", source.commit],
    "Cannot check out the recorded commit."
  );
  // Rehash all tracked files to detect path aliases or other filesystem conversions.
  await git(["add", "--renormalize", "--", "."], "Cannot verify the materialized Git tree.");
  if ((await git(["write-tree"], "Cannot verify the materialized Git tree.")) !== source.treeSha)
    throw new Error("Local checkout does not match the recorded Git tree.");

  // Cloud runs with the archived files. Keep checkout metadata out of the recipe's cwd.
  await rm(join(cwd, ".git"), { recursive: true });

  const stat = async (name: string) =>
    lstat(join(cwd, name)).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return undefined;
    });
  for (const name of [".npmrc", "bunfig.toml"]) {
    if (await stat(name))
      throw new Error(
        `Reproduction requires default public registry configuration. Found ${name}.`
      );
  }

  const lockfile = join(cwd, source.lockfile.path);
  if (!(await stat(source.lockfile.path))?.isFile())
    throw new Error("Recorded bun.lock is missing or invalid.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(lockfile, { signal })) hash.update(chunk);
  if (hash.digest("base64url") !== source.lockfile.digest)
    throw new Error("Local bun.lock does not match the recorded lockfile digest.");

  const plan = await readNodeCheckPlan(cwd).catch(() => {
    throw new Error("Pinned source has an unsupported Node check configuration.");
  });
  if ((await digestNodeCheckPlan(plan)) !== planDigest)
    throw new Error("Resolved Node check plan does not match the recorded plan digest.");
  return plan;
}
