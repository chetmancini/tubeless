import { readFile } from "node:fs/promises";
import type { ReproductionManifest } from "../utilities/reproduction-manifest.js";
import { readCheckToolVersion, runCheckProcess } from "./process.js";
import { executeNodeCheckPlan } from "./recipe.js";
import { prepareReproductionPlan, withReproductionWorkspace } from "./reproduction-source.js";

/** Run the admitted recipe with local tools, a temporary checkout and a fresh environment. */
export async function reproduceCheck(manifest: ReproductionManifest, signal: AbortSignal) {
  return withReproductionWorkspace(signal, async (location) => {
    const { cwd, env } = location;
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

    const plan = await prepareReproductionPlan(manifest, location, nodeCheck.digest);
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
  });
}
