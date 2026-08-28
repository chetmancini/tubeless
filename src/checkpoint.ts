import * as fs from "fs";
import * as path from "path";

export interface CheckpointStore<TMeta = unknown> {
  has(key: string): boolean;
  record(key: string, meta?: TMeta): void;
  entries(): ReadonlyMap<string, TMeta | undefined>;
  flush(): void;
  /**
   * Whether to call this is the caller's choice: clear-on-completion suits one-shot
   * resumable jobs (a full successful run means "start fresh next time"), while
   * never-clear suits pipelines with an incrementally-growing "done" set (e.g. entity
   * enrichment) where auto-clearing would cause reprocessing and duplicate output.
   */
  clear(): void;
}

function loadEntries<TMeta>(
  filePath: string,
  onCorruptFile: (cause: unknown) => void
): Map<string, TMeta | undefined> {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  try {
    // SAFETY: the file is expected to hold a JSON object whose values are
    // TMeta entries, as written by this store's flush(). Object.entries only
    // yields string keys, so the `as Record<string, TMeta>` documents the
    // caller-supplied TMeta contract; any mismatch is caught by the try/catch.
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, TMeta>;
    return new Map(Object.entries(parsed));
  } catch (error) {
    onCorruptFile(error);
    return new Map();
  }
}

export interface OpenCheckpointOptions {
  /**
   * Called when the checkpoint file exists but fails to parse, right before falling
   * back to an empty checkpoint. Starting fresh from a corrupt file is silent
   * reprocessing of every previously-checkpointed item — the default logs a warning to
   * `console` so that cost is visible instead of masked. Pass a no-op to suppress it.
   */
  onCorruptFile?: (cause: unknown) => void;
}

export function openCheckpoint<TMeta = unknown>(
  filePath: string,
  options: OpenCheckpointOptions = {}
): CheckpointStore<TMeta> {
  const onCorruptFile =
    options.onCorruptFile ??
    ((cause: unknown) => {
      console.warn(
        `Checkpoint file ${filePath} is corrupt; starting fresh (all previously checkpointed items will be reprocessed): ${cause instanceof Error ? cause.message : String(cause)}`
      );
    });
  const entries = loadEntries<TMeta>(filePath, onCorruptFile);

  return {
    has: (key) => entries.has(key),
    record: (key, meta) => {
      entries.set(key, meta);
    },
    entries: () => entries,
    flush: () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Records made without a `meta` argument store `undefined`, which JSON.stringify
      // silently drops from object properties — without the replacer below, every
      // meta-less key would vanish from the file on flush. Substituting `null` keeps
      // the key present; callers that never pass `meta` only care about `has()`, not
      // the exact value round-tripped through `entries()`.
      const json = JSON.stringify(
        Object.fromEntries(entries),
        (_key, value) => (value === undefined ? null : value),
        2
      );
      // Write to a sibling temp file and rename over the destination rather than
      // writeFileSync-ing the target directly: a crash or process kill mid-write would
      // otherwise leave a truncated, unparseable checkpoint file, and the next run would
      // silently treat it as empty and reprocess everything already done. Rename is
      // atomic on the same filesystem, so the checkpoint file is always either the
      // previous complete flush or the new complete one, never a partial write.
      const tmpPath = `${filePath}.tmp-${process.pid}`;
      try {
        fs.writeFileSync(tmpPath, `${json}\n`);
        fs.renameSync(tmpPath, filePath);
      } catch (error) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          // Best-effort cleanup; surface the original write/rename error.
        }
        throw error;
      }
    },
    clear: () => {
      entries.clear();
      fs.rmSync(filePath, { force: true });
    },
  };
}

/**
 * Runs `persist()`, and only once it resolves without throwing, records every item in
 * `batch` into `checkpoint` and flushes it. A `persist` failure (a write error, etc.)
 * propagates and leaves the checkpoint untouched for this batch — the caller decides
 * whether to skip the batch and retry it later or fail the whole run. This makes the
 * checkpoint-outruns-persistence ordering bug impossible to write by construction:
 * there is no way to call `checkpoint.record()` before `persist()` has already succeeded.
 */
export async function withCheckpointedBatch<TItem>(
  checkpoint: CheckpointStore,
  batch: readonly TItem[],
  keyOf: (item: TItem) => string,
  persist: () => Promise<void> | void
): Promise<void> {
  await persist();
  for (const item of batch) {
    checkpoint.record(keyOf(item));
  }
  checkpoint.flush();
}
