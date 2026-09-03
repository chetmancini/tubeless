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
  /**
   * Release the exclusive lock without deleting checkpoint entries. Idempotent.
   * After close, another `openCheckpoint` on the same path may succeed.
   * `has`/`entries` remain readable; `record`, `flush`, and `clear` throw.
   */
  close(): void;
}

export class CheckpointLockedError extends Error {
  readonly code = "TUBELESS_CHECKPOINT_LOCKED";

  constructor(filePath: string, holderPid: number) {
    super(`Checkpoint ${filePath} is locked by process ${holderPid}`);
    this.name = "CheckpointLockedError";
  }
}

const heldLockPaths = new Set<string>();
let exitHookRegistered = false;

function ensureExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => {
    for (const lockPath of heldLockPaths) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Best-effort: a crashed process leaves a stale lock the next open reclaims.
      }
    }
  });
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

function readLockContents(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

function holderPidFromContents(contents: string): number | undefined {
  const firstLine = contents.split("\n", 1)[0];
  const pid = Number(firstLine);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function readLockHolder(lockPath: string): number | undefined {
  const contents = readLockContents(lockPath);
  return contents === undefined ? undefined : holderPidFromContents(contents);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: process.kill throws Node system errors. EPERM means the pid
    // exists but we cannot signal it — treat as live so a long-running holder
    // is never reclaimed. ESRCH (and anything else) is dead.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createExclusiveLock(lockPath: string): void {
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Descriptor may already be closed; still remove the incomplete lock.
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Best-effort: a leftover file would look like an in-progress or live lock.
    }
    throw error;
  }
  heldLockPaths.add(lockPath);
  ensureExitHook();
}

function releaseCheckpointLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath);
  } catch (error) {
    // SAFETY: Node fs rejects with ErrnoException. Only ENOENT means the lock
    // path is already gone; EACCES/EPERM and other failures keep ownership so
    // close() can be retried and the exit hook can still see the path.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  heldLockPaths.delete(lockPath);
}

function claimStaleLock(lockPath: string): boolean {
  const tombstone = `${lockPath}.reclaim-${process.pid}-${process.hrtime.bigint().toString()}`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch (error) {
    // SAFETY: rename of a missing path is ENOENT — another opener already
    // moved this inode, so we must not create a second live lock.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    fs.rmSync(tombstone, { force: true });
  } catch {
    // The lock path no longer names this inode; a leftover tombstone is not a lock.
  }
  return true;
}

function throwLocked(filePath: string, lockPath: string, fallbackPid?: number): never {
  throw new CheckpointLockedError(filePath, readLockHolder(lockPath) ?? fallbackPid ?? 0);
}

/**
 * The lock protects the checkpoint path, not the file: a lock without a checkpoint
 * file still excludes other openers. Live holders are never reclaimed. An empty
 * lock is treated as in-progress create (openSync wx before writeSync), not stale.
 * Unparseable nonempty contents and dead pids are stale. Replacement claims the
 * current inode with an atomic rename before creating a new lock; a racing
 * reclaim that loses the rename does not unlink the winner.
 */
function acquireCheckpointLock(filePath: string): string {
  const lockPath = lockPathFor(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    createExclusiveLock(lockPath);
    return lockPath;
  } catch (error) {
    // SAFETY: fs.openSync("wx") throws Node system errors; EEXIST means another
    // holder already created the lock file.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const snapshot = readLockContents(lockPath);
  if (snapshot === undefined) {
    try {
      createExclusiveLock(lockPath);
      return lockPath;
    } catch (error) {
      // SAFETY: vanished lock may already have been replaced by another opener.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throwLocked(filePath, lockPath);
    }
  }
  if (snapshot.length === 0) {
    throwLocked(filePath, lockPath);
  }
  const holderPid = holderPidFromContents(snapshot);
  if (holderPid !== undefined && isProcessAlive(holderPid)) {
    throw new CheckpointLockedError(filePath, holderPid);
  }

  const current = readLockContents(lockPath);
  if (current !== snapshot) {
    const currentPid = current === undefined ? undefined : holderPidFromContents(current);
    if (currentPid !== undefined && isProcessAlive(currentPid)) {
      throw new CheckpointLockedError(filePath, currentPid);
    }
    throwLocked(filePath, lockPath, currentPid ?? holderPid);
  }

  if (!claimStaleLock(lockPath)) {
    throwLocked(filePath, lockPath, holderPid);
  }

  try {
    createExclusiveLock(lockPath);
    return lockPath;
  } catch (error) {
    // SAFETY: the retry also uses openSync("wx"); EEXIST means another process
    // won the race after claiming the stale inode.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throwLocked(filePath, lockPath, holderPid);
  }
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
  const lockPath = acquireCheckpointLock(filePath);
  let closed = false;
  let entries: Map<string, TMeta | undefined>;
  try {
    entries = loadEntries<TMeta>(filePath, onCorruptFile);
  } catch (error) {
    releaseCheckpointLock(lockPath);
    throw error;
  }

  const close = (): void => {
    if (closed) return;
    releaseCheckpointLock(lockPath);
    closed = true;
  };
  const assertWritable = (): void => {
    if (closed) throw new Error(`Checkpoint ${filePath} is closed`);
  };

  return {
    has: (key) => entries.has(key),
    record: (key, meta) => {
      assertWritable();
      entries.set(key, meta);
    },
    entries: () => entries,
    flush: () => {
      assertWritable();
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
      assertWritable();
      entries.clear();
      fs.rmSync(filePath, { force: true });
    },
    close,
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
