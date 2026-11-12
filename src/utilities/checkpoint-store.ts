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
