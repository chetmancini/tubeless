import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSample, type Sample } from "./sample.ts";

const suffix = ".sample.json";

export async function readSamples(directory: string, recursive: boolean): Promise<Sample[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map(async (entry) => {
        const file = join(entry.parentPath, entry.name);
        if ((await stat(file)).size > 65536) throw new Error("Benchmark sample exceeds 64 KiB.");
        return readSample(JSON.parse(await readFile(file, "utf8")) as unknown);
      })
  );
}

/** Acquire one writer for a logical trial. Each invocation gets its own durable checkpoint. */
export async function lockTrial(directory: string) {
  const lock = join(directory, ".active");
  await mkdir(lock, { mode: 0o700 });
  return () => rmdir(lock);
}

export async function checkpointSample(directory: string, sample: Sample) {
  readSample(sample);
  const text = JSON.stringify(sample, null, 2) + "\n";
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
    !first?.target?.principalId ||
    first.mode !== "cloud" ||
    samples.filter((sample) => sample.operation === "start").length !== 1
  )
    throw new Error("Recovery requires an existing Cloud trial with a bound principal.");
  const { target, workload, attemptId } = first;
  const keys = Object.keys(target) as (keyof typeof target)[];
  if (
    samples.some(
      (sample) =>
        !sample.target ||
        sample.attemptId !== attemptId ||
        sample.mode !== "cloud" ||
        sample.workload.variant !== workload.variant ||
        keys.some((key) => sample.target?.[key] !== target[key])
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
