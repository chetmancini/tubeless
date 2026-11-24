import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  digestNodeCheckPlan,
  type ReproductionManifest,
} from "../utilities/reproduction-manifest.js";
import { runCheckProcess } from "./process.js";
import { executeNodeCheck, readNodeCheckPlan } from "./recipe.js";
import { prepareReproductionSource } from "./reproduction-source.js";

const silent = { log() {}, error() {}, warn() {} };

/** Run the admitted recipe with local tools, a temporary checkout and a fresh environment. */
export async function reproduceCheck(manifest: ReproductionManifest, signal: AbortSignal) {
  if (process.platform === "win32") throw new Error("Reproduction requires a POSIX host.");
  const root = await mkdtemp(join(tmpdir(), "tubeless-reproduce-"));
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
    };
    const { nodeCheck, runtime: recorded } = manifest;
    const probe = async (tool: "node" | "bun", required: string): Promise<string> => {
      let output = "";
      const result = await runCheckProcess(
        [tool, "--version"],
        5000,
        {
          cwd,
          signal,
          log: {
            ...silent,
            log: (chunk) => {
              output += String(chunk);
            },
          },
        },
        env
      );
      signal.throwIfAborted();
      const version = output.trim().replace(/^v/, "");
      if (
        result.status !== "exited" ||
        result.exitCode !== 0 ||
        !result.outputComplete ||
        !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]{1,64})?$/.test(version)
      )
        throw new Error(
          `Reproduction requires ${tool} ${required} on PATH. Could not read its version.`
        );
      return version;
    };
    const node = await probe("node", nodeCheck.plan.toolchain.node);
    if (node.split(".")[0] !== nodeCheck.plan.toolchain.node)
      throw new Error(
        `Reproduction requires Node ${nodeCheck.plan.toolchain.node}. Found ${node}.`
      );
    const bun = await probe("bun", nodeCheck.plan.toolchain.bun);
    if (bun !== nodeCheck.plan.toolchain.bun)
      throw new Error(`Reproduction requires Bun ${nodeCheck.plan.toolchain.bun}. Found ${bun}.`);

    await prepareReproductionSource(manifest, cwd, env, signal);
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
    const execution = await executeNodeCheck(
      plan,
      { cwd, signal, log: silent },
      {
        runtime: { nodeVersion: node, env },
      }
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
