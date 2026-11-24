import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  digestNodeCheckPlan,
  type ReproductionManifest,
} from "../utilities/reproduction-manifest.js";
import { readNodeCheckPlan } from "./node-check.js";
import { readCheckToolVersion, runCheckProcess } from "./process.js";
import { executeNodeCheckPlan } from "./recipe.js";
import { prepareReproductionSource } from "./reproduction-source.js";

/** Run the admitted recipe with local tools, a temporary checkout and a fresh environment. */
export async function reproduceCheck(manifest: ReproductionManifest, signal: AbortSignal) {
  if (process.platform === "win32") throw new Error("Reproduction requires a POSIX host.");
  // Vitest reports physical paths, so the subprocess and report adapter need the same root.
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
    const location = { cwd, env, signal };
    const { nodeCheck, runtime: recorded } = manifest;
    const required = nodeCheck.plan.toolchain;
    const [node, bun] = await Promise.all([
      readCheckToolVersion("node", location),
      readCheckToolVersion("bun", location),
    ]);
    signal.throwIfAborted();
    if (node?.split(".")[0] !== required.node)
      throw new Error(
        `Reproduction requires Node ${required.node} on PATH. Found ${node ?? "no usable Node"}.`
      );
    if (bun !== required.bun)
      throw new Error(
        `Reproduction requires Bun ${required.bun} on PATH. Found ${bun ?? "no usable Bun"}.`
      );

    await prepareReproductionSource(manifest, location);
    const plan = await readNodeCheckPlan(cwd).catch(() => {
      throw new Error("Pinned source has an unsupported Node check configuration.");
    });
    if ((await digestNodeCheckPlan(plan)) !== nodeCheck.digest)
      throw new Error("Resolved Node check plan does not match the recorded plan digest.");
    const { version: tubeless } = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version: string };
    const local = { node, bun, tubeless, platform: process.platform, arch: process.arch };
    const differences = (["node", "bun", "tubeless"] as const).flatMap((tool) =>
      recorded[tool] !== null && recorded[tool] !== local[tool]
        ? [{ tool, recorded: recorded[tool], local: local[tool] }]
        : []
    );
    signal.throwIfAborted();
    const execution = await executeNodeCheckPlan(plan, { cwd, signal }, (command, step) =>
      runCheckProcess(command.argv, command.timeoutMs, { cwd, env, signal: step.signal })
    );
    return {
      version: 1,
      original: {
        run: manifest.run,
        repository: manifest.repository,
        source: manifest.source,
        planDigest: nodeCheck.digest,
        runtime: recorded,
        diagnostics: manifest.diagnostics,
      },
      local,
      differences,
      execution,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
