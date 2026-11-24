import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReproductionManifest } from "../utilities/reproduction-manifest.js";
import { runCheckProcess } from "./process.js";

/** Fetch only the pinned GitHub object. Caller Git configuration is available only during fetch. */
export async function prepareReproductionSource(
  manifest: ReproductionManifest,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<void> {
  const { source, repository } = manifest;
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const fetchEnv = {
    PATH: env.PATH,
    TMPDIR: env.TMPDIR,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    GIT_ALLOW_PROTOCOL: "https:ssh",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args: string[], failure: string, fetch = false): Promise<string> => {
    let output = "";
    const outcome = await runCheckProcess(
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
      fetch ? 120_000 : 30_000,
      {
        cwd,
        signal,
        log: {
          log: (chunk) => {
            if (!fetch) output += String(chunk);
          },
          warn() {},
          error() {},
        },
      },
      fetch ? fetchEnv : gitEnv
    );
    signal.throwIfAborted();
    if (
      outcome.status !== "exited" ||
      outcome.exitCode !== 0 ||
      (!fetch && !outcome.outputComplete)
    )
      throw new Error(failure);
    return output.trim();
  };

  await git(["--version"], "Git is required on PATH.");
  await git(
    ["init", "-q", "--template=", "--object-format=sha1"],
    "Cannot initialize the temporary Git checkout."
  );
  await git(
    [
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
    `Cannot fetch recorded commit ${source.commit}. Check Git access and whether the revision is still available.`,
    true
  );
  if (
    (await git(
      ["rev-parse", "--verify", `${source.commit}^{commit}`],
      "Recorded commit is unavailable."
    )) !== source.commit
  )
    throw new Error("Fetched Git commit does not match the recorded commit.");
  if (
    (await git(
      ["rev-parse", "--verify", `${source.commit}^{tree}`],
      "Recorded Git tree is unavailable."
    )) !== source.treeSha
  )
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
}
