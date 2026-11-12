/** Mutable set of completed item keys backed by an explicit JSON flush. */
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

/**
 * Copy a checkpoint into a writable store that never reaches the source. Previews use it
 * so recording during a dry run cannot mark work done: `has` reads the copied keys,
 * `record` writes to the copy, and `flush` does nothing.
 */
export function inMemoryCheckpointStore<TMeta = unknown>(
  seed: ReadonlyMap<string, TMeta | undefined> = new Map()
): CheckpointStore<TMeta> {
  const entries = new Map(seed);
  return {
    has: (key) => entries.has(key),
    record: (key, meta) => {
      entries.set(key, meta);
    },
    entries: () => entries,
    flush: () => {},
    clear: () => {
      entries.clear();
    },
  };
}
