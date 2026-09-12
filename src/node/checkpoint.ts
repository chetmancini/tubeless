import * as fs from "fs";
import { writeAtomicText } from "./atomic-text.js";

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

function isCheckpointRecord<T>(value: T): value is T & object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadEntries<TMeta>(
  filePath: string,
  onCorruptFile: (cause: unknown) => void
): Map<string, TMeta | undefined> {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  try {
    // The file must be a JSON object keyed by item IDs, as written by flush().
    // JSON.parse also accepts arrays and scalars; those are corrupt containers.
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isCheckpointRecord(parsed)) {
      const kind =
        parsed === null
          ? "null"
          : Array.isArray(parsed)
            ? "array"
            : Object.prototype.toString.call(parsed).slice(8, -1).toLowerCase();
      throw new Error(`Checkpoint file must be a JSON object keyed by item IDs, not ${kind}`);
    }
    // SAFETY: isCheckpointRecord only proves a non-null, non-array object. The
    // `as Record<string, TMeta>` documents the caller-supplied TMeta contract
    // only; generic metadata is not validated.
    return new Map(Object.entries(parsed as Record<string, TMeta>));
  } catch (error) {
    onCorruptFile(error);
    return new Map();
  }
}

export interface OpenCheckpointOptions {
  /**
   * Called when the checkpoint file exists but is unusable, right before falling
   * back to an empty checkpoint. That includes JSON syntax errors and valid JSON
   * whose top-level value is not an object keyed by item IDs (arrays, strings,
   * numbers, booleans, and `null`). Starting fresh from a corrupt file is silent
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
      writeAtomicText(filePath, `${json}\n`);
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
