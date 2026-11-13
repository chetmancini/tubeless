import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readlink, realpath, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { PipelineRunEventStore } from "../run-store/run-store.js";
import type { PipelineTraceEvent, PipelineTraceExporter } from "../tracing/tracing.js";
import { writeCliChunk, type WorkbenchCliIo } from "./workbench-shared.js";

/** Local run destinations opened for one launch: an optional SQLite store and NDJSON trace. */
export interface WorkbenchRecording {
  /** Trace exporters in recording order; empty when neither destination was requested. */
  readonly exporters: readonly PipelineTraceExporter[];
  /** Close the trace, then the store. Returns every close error so callers report each one. */
  close(): Promise<unknown[]>;
}

/**
 * Open `--store` and `--trace` destinations. A trace of `-` writes NDJSON to
 * stdout. If one destination fails to open, the other is closed before rethrowing.
 */
export async function openWorkbenchRecording(
  destinations: { readonly store?: string; readonly trace?: string },
  io: WorkbenchCliIo,
  signal: AbortSignal
): Promise<WorkbenchRecording> {
  const exporters: PipelineTraceExporter[] = [];
  let store: PipelineRunEventStore | undefined;
  let closeTrace: (() => Promise<void>) | undefined;
  const close = async () => {
    const errors: unknown[] = [];
    for (const step of [closeTrace, () => store?.close()]) {
      try {
        await step?.();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };
  try {
    if (destinations.store) {
      const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
      store = await openSqlitePipelineRunStore(path.resolve(io.cwd, destinations.store));
      exporters.push(store);
    }
    if (destinations.trace) {
      const writer = await createRunTraceWriter(destinations.trace, io, signal);
      closeTrace = writer.close;
      exporters.push(writer.exporter);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { exporters, close };
}

/** True when the store (including SQLite sidecar files) and trace resolve to the same file. */
export async function recordingDestinationsConflict(
  destinations: { readonly store?: string; readonly trace?: string },
  cwd: string
): Promise<boolean> {
  const { store, trace } = destinations;
  if (!store || !trace || trace === "-") return false;
  return destinationsConflict(path.resolve(cwd, store), path.resolve(cwd, trace));
}

async function createRunTraceWriter(
  destination: string,
  io: WorkbenchCliIo,
  signal: AbortSignal
): Promise<{
  close(): Promise<void>;
  exporter: PipelineTraceExporter;
}> {
  // Nested runs share this exporter but have separate emission queues. Serialize
  // at the destination so only one flush/error/close listener set is active.
  let writes = Promise.resolve();
  const writeEvent = (output: WorkbenchCliIo["stdout"], event: PipelineTraceEvent) => {
    const chunk = `${JSON.stringify(event)}\n`;
    writes = writes.then(() => writeCliChunk(output, chunk, signal));
    return writes;
  };

  if (destination === "-") {
    let writeError: Error | undefined;
    return {
      close: async () => {
        if (signal.aborted) return;
        if (writeError) throw writeError;
      },
      exporter: {
        async export(event) {
          if (writeError) throw writeError;
          try {
            await writeEvent(io.stdout, event);
          } catch (error) {
            writeError = error instanceof Error ? error : new Error(String(error));
            throw writeError;
          }
        },
      },
    };
  }

  const filename = path.resolve(io.cwd, destination);
  await mkdir(path.dirname(filename), { recursive: true });
  const stream = createWriteStream(filename);
  let writeError: Error | undefined;
  stream.on("error", (error) => {
    writeError = error;
  });
  const destroyOnAbort = () => {
    if (!stream.destroyed) stream.destroy();
  };
  await waitForWriteStreamOpen(stream, signal);
  if (signal.aborted) destroyOnAbort();
  else signal.addEventListener("abort", destroyOnAbort, { once: true });
  return {
    close: () =>
      new Promise((resolve, reject) => {
        const retainedError =
          writeError ?? (stream.errored instanceof Error ? stream.errored : undefined);
        signal.removeEventListener("abort", destroyOnAbort);
        if (retainedError) {
          reject(retainedError);
          return;
        }
        if (signal.aborted || stream.destroyed) {
          destroyOnAbort();
          resolve();
          return;
        }
        stream.end((error?: Error | null) => {
          if (error) reject(error);
          else if (writeError) reject(writeError);
          else resolve();
        });
      }),
    exporter: {
      async export(event) {
        if (writeError) throw writeError;
        await writeEvent(stream, event);
        if (writeError) throw writeError;
      },
    },
  };
}

async function waitForWriteStreamOpen(stream: WriteStream, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    stream.destroy();
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
  if (stream.errored) throw stream.errored;
  if (!stream.pending) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function destinationsConflict(storePath: string, tracePath: string): Promise<boolean> {
  if (await pathsShareIdentity(storePath, tracePath)) return true;
  const storeTargets = new Set([storePath, await canonicalDestination(storePath)]);
  for (const storeTarget of storeTargets) {
    for (const suffix of ["-journal", "-shm", "-wal"] as const) {
      if (await pathsShareIdentity(`${storeTarget}${suffix}`, tracePath)) return true;
    }
  }
  return false;
}

async function canonicalDestination(filename: string, depth = 0): Promise<string> {
  if (depth > 32) return path.resolve(filename);
  try {
    return await realpath(filename);
  } catch {
    // Missing leaf or dangling symlink.
  }
  try {
    const target = await readlink(filename);
    return canonicalDestination(path.resolve(path.dirname(filename), target), depth + 1);
  } catch {
    // Not a symlink.
  }
  const resolved = path.resolve(filename);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(await canonicalDestination(parent, depth + 1), path.basename(resolved));
}

async function pathsShareIdentity(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    canonicalDestination(left),
    canonicalDestination(right),
  ]);
  if (leftPath === rightPath) return true;
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
  } catch {
    // One or both dests do not exist yet.
  }
  if (leftPath.toLowerCase() !== rightPath.toLowerCase()) return false;
  return directoryIgnoresCase(
    (await nearestExistingDirectory(path.dirname(leftPath))) ??
      (await nearestExistingDirectory(path.dirname(rightPath)))
  );
}

async function nearestExistingDirectory(dir: string): Promise<string | undefined> {
  let current = dir;
  while (true) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Missing or not a directory; walk toward the root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function directoryIgnoresCase(dir: string | undefined): Promise<boolean> {
  if (dir === undefined) return true;
  const id = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const probe = path.join(dir, `.tubeless-case-${id}-a`);
  const flipped = path.join(dir, `.tubeless-case-${id}-A`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch {
    // Cannot probe; treat a case-fold match as a collision so --trace cannot
    // truncate a store on a case-insensitive volume.
    return true;
  }
  try {
    const [probeStat, flippedStat] = await Promise.all([stat(probe), stat(flipped)]);
    return probeStat.dev === flippedStat.dev && probeStat.ino === flippedStat.ino;
  } catch {
    return false;
  } finally {
    await unlink(probe).catch(() => {});
  }
}
