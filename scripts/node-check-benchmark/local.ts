import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { prepareReproductionSource } from "../../dist/check/reproduction-source.js";
import { readCheckToolVersion, runCheckProcess } from "../../dist/check/process.js";
import { executeNodeCheckPlan } from "../../dist/check/recipe.js";
import { readNodeCheckPlan } from "tubeless/node/check";
import { digestNodeCheckPlan } from "tubeless/reproduction-manifest";
import { checkOutcome } from "./outcome.ts";
import type { Checkpoint, Sample } from "./sample.ts";

export async function runLocal(sample: Sample, signal: AbortSignal, checkpoint: Checkpoint) {
  const start = performance.now();
  const root = await mkdtemp(join(await realpath(tmpdir()), "tubeless-benchmark-"));
  try {
    const cwd = join(root, "source");
    const home = join(root, "home");
    const temp = join(root, "tmp");
    const cache = join(root, "bun-cache");
    await Promise.all([cwd, home, temp, cache].map((dir) => mkdir(dir)));
    const env = {
      PATH: (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => isAbsolute(dir))
        .join(delimiter),
      HOME: home,
      TMPDIR: temp,
      BUN_INSTALL_CACHE_DIR: cache,
      CI: "true",
      CF_SEND_TELEMETRY: "false",
      NO_COLOR: "1",
      GIT_CEILING_DIRECTORIES: root,
    };
    const location = { cwd, env, signal };
    const [node, bun] = await Promise.all([
      readCheckToolVersion("node", location),
      readCheckToolVersion("bun", location),
    ]);
    sample.tools.node = node ?? null;
    sample.tools.bun = bun ?? null;
    signal.throwIfAborted();
    if (!node?.startsWith("24.") || bun !== "1.4.4")
      throw new Error("The local workload requires Node 24 and Bun 1.4.4 on PATH.");
    const { commit, treeSha, repository, lockfileDigest, planDigest } = sample.workload;
    await prepareReproductionSource(
      {
        repository: { id: "1291714638", fullName: repository },
        source: { commit, treeSha, lockfile: { path: "bun.lock", digest: lockfileDigest } },
      },
      location
    );
    const plan = await readNodeCheckPlan(cwd);
    if ((await digestNodeCheckPlan(plan)) !== planDigest) throw new Error("Pinned plan mismatch.");
    signal.throwIfAborted();
    sample.execution.identity = "verified";
    sample.observation.localPreparationMs = performance.now() - start;
    sample.observation.stage = "execute";
    await checkpoint();
    const executing = performance.now();
    const execution = await executeNodeCheckPlan(plan, { cwd, signal }, (command, step) =>
      runCheckProcess(command.argv, command.timeoutMs, { ...location, signal: step.signal })
    );
    const terminal = performance.now();
    sample.observation.localRecipeMs = terminal - executing;
    sample.execution.runId = execution.run.runId;
    sample.execution.outcome = execution.commands.some(
      ({ process }) => process.status === "timed-out"
    )
      ? "timed-out"
      : checkOutcome(execution.run.status, execution.reports[0]?.result);
    signal.throwIfAborted();
    sample.observation.terminalMs = terminal - start;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
