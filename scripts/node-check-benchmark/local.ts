import {
  prepareReproductionPlan,
  withReproductionWorkspace,
} from "../../dist/check/reproduction-source.js";
import { readCheckToolVersion, runCheckProcess } from "../../dist/check/process.js";
import { executeNodeCheckPlan } from "../../dist/check/recipe.js";
import { checkOutcome } from "./workload.ts";
import type { Checkpoint, LocalSample } from "./sample.ts";

export async function runLocal(sample: LocalSample, signal: AbortSignal, checkpoint: Checkpoint) {
  const start = performance.now();
  return withReproductionWorkspace(signal, async (location) => {
    const { cwd } = location;
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
    const plan = await prepareReproductionPlan(
      {
        repository: { fullName: repository },
        source: { commit, treeSha, lockfile: { path: "bun.lock", digest: lockfileDigest } },
      },
      location,
      planDigest
    );
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
      : checkOutcome(
          sample.workload,
          execution.run.status,
          execution.reports.find(({ stepId }) => stepId === "test")?.result
        );
    signal.throwIfAborted();
    sample.observation.terminalMs = terminal - start;
  });
}
