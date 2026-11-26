import { mkdir, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runConcurrent } from "tubeless/batch";
import { readCliJson } from "../../dist/workbench/workbench-json-input.js";
import { readSample, type Sample } from "./sample.ts";

const suffix = ".sample.json";

export async function readSamples(directory: string, recursive: boolean): Promise<Sample[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive });
  const signal = new AbortController().signal;
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  return runConcurrent(files, { concurrency: 8 }, async (entry) =>
    readSample(await readCliJson(entry.name, { cwd: entry.parentPath, signal }, "Benchmark sample"))
  );
}

/** Hold an exclusive writer lock for the entire trial invocation. */
export async function withTrial<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const lock = join(directory, ".active");
  await mkdir(lock, { mode: 0o700 });
  try {
    return await run();
  } finally {
    await rmdir(lock);
  }
}

export async function checkpointSample(directory: string, sample: Sample) {
  const text = JSON.stringify(readSample(sample), null, 2) + "\n";
  if (
    sample.mode !== "local" &&
    process.env.TUBELESS_TOKEN &&
    text.includes(process.env.TUBELESS_TOKEN)
  )
    throw new Error("Credential detected in benchmark sample.");
  const file = join(directory, sample.invocationId + suffix);
  const pending = file + ".tmp";
  await writeFile(pending, text, { mode: 0o600 });
  await rename(pending, file);
}

export function recoveryIntent(samples: Sample[], operation: "resume" | "replay", now: number) {
  const first = samples.find((sample) => sample.operation === "start");
  if (
    first?.mode !== "cloud" ||
    !first.target.principalId ||
    samples.filter((sample) => sample.operation === "start").length !== 1
  )
    throw new Error("Recovery requires an existing Cloud trial with a bound principal.");
  const { target, workload, attemptId } = first;
  if (
    samples.some(
      (sample) =>
        sample.mode !== "cloud" ||
        sample.attemptId !== attemptId ||
        !isDeepStrictEqual(sample.workload, workload) ||
        !isDeepStrictEqual(sample.target, target)
    )
  )
    throw new Error("Inconsistent Cloud trial ledger.");
  const ids = new Set(samples.flatMap(({ execution }) => execution.runId ?? []));
  if (ids.size > 1) throw new Error("Cloud trial has conflicting run IDs.");
  const runId = ids.values().next().value ?? null;
  if (operation === "resume" && !runId)
    throw new Error("The admission is uncertain. Use explicit replay within its window.");
  if (operation === "replay" && runId)
    throw new Error("A run ID is recorded. Use resume to observe it.");
  const age = now - Date.parse(first.startedAt);
  if (operation === "replay" && !(age >= 0 && age < 60 * 60 * 1000))
    throw new Error(
      "The replay window has closed. Reconcile the attempt with Cloud before any further submission."
    );
  return { workload, target, attemptId, runId, mode: first.mode } as const;
}
