import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointLockedError, openCheckpoint, withCheckpointedBatch } from "./checkpoint.js";

// ESM `fs` exports are non-configurable, so `vi.spyOn(fs, ...)` throws.
// `{ spy: true }` wraps the same module `checkpoint.ts` imports.
vi.mock("fs", { spy: true });

describe("openCheckpoint", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
    filePath = path.join(dir, "run.checkpoint.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when no file exists", () => {
    const checkpoint = openCheckpoint(filePath);
    expect(checkpoint.has("a")).toBe(false);
    expect(checkpoint.entries().size).toBe(0);
  });

  it("records keys in memory before flush without writing the file", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    expect(checkpoint.has("a")).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("persists recorded keys and metadata on flush", () => {
    const checkpoint = openCheckpoint<{ attempt: number }>(filePath);
    checkpoint.record("a", { attempt: 1 });
    checkpoint.flush();
    checkpoint.close();

    const reopened = openCheckpoint<{ attempt: number }>(filePath);
    expect(reopened.has("a")).toBe(true);
    expect(reopened.entries().get("a")).toEqual({ attempt: 1 });
    reopened.close();
  });

  it("persists a key recorded without metadata across a reload", () => {
    // record() without a `meta` argument stores `undefined`, which JSON.stringify
    // silently omits from a plain object — a reopened checkpoint must still see the
    // key as recorded, not treat it as never having been written.
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    checkpoint.flush();
    checkpoint.close();

    const reopened = openCheckpoint(filePath);
    expect(reopened.has("a")).toBe(true);
    expect(reopened.entries().size).toBe(1);
    reopened.close();
  });

  it("deletes the checkpoint file on clear", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    checkpoint.flush();
    expect(fs.existsSync(filePath)).toBe(true);

    checkpoint.clear();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(checkpoint.has("a")).toBe(false);
    checkpoint.close();
  });

  it("tolerates a corrupt checkpoint file by starting fresh", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "{not json");
    const checkpoint = openCheckpoint(filePath);
    expect(checkpoint.entries().size).toBe(0);
  });

  it("reports corrupt files instead of failing silently", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "{not json");
    const errors: unknown[] = [];
    const checkpoint = openCheckpoint(filePath, { onCorruptFile: (error) => errors.push(error) });
    expect(checkpoint.entries().size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("warns on console by default when the checkpoint file is corrupt", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    openCheckpoint(filePath);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(filePath);
    warn.mockRestore();
  });

  it("never leaves a partial file behind: flush only ever produces a complete, parseable file", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a", { attempt: 1 });
    checkpoint.flush();

    // Assert on the actual bytes on disk, not just the in-memory view, and that no
    // leftover temp file from the atomic-rename strategy survives the flush.
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk).toEqual({ a: { attempt: 1 } });
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(true);
    checkpoint.close();
  });

  it("failed rename leaves no temp file and preserves the previous complete checkpoint", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a", { attempt: 1 });
    checkpoint.flush();
    checkpoint.record("b", { attempt: 2 });

    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error("rename exploded");
    });
    try {
      expect(() => checkpoint.flush()).toThrow("rename exploded");
      expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ a: { attempt: 1 } });
    } finally {
      vi.mocked(fs.renameSync).mockRestore();
    }
  });

  it("failed writeFileSync leaves no temp file and preserves the previous complete checkpoint", async () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a", { attempt: 1 });
    checkpoint.flush();
    checkpoint.record("b", { attempt: 2 });

    const actualFs = await vi.importActual<typeof import("fs")>("fs");
    vi.mocked(fs.writeFileSync).mockImplementation((target, data, options) => {
      actualFs.writeFileSync(target, data, options as never);
      throw new Error("write exploded");
    });
    try {
      expect(() => checkpoint.flush()).toThrow("write exploded");
      expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ a: { attempt: 1 } });
    } finally {
      vi.mocked(fs.writeFileSync).mockRestore();
    }
  });

  it("rejects a second live open of the same path with TUBELESS_CHECKPOINT_LOCKED", () => {
    const holder = openCheckpoint(filePath);
    try {
      expect(() => openCheckpoint(filePath)).toThrow(
        expect.objectContaining({
          code: "TUBELESS_CHECKPOINT_LOCKED",
          name: "CheckpointLockedError",
          message: expect.stringContaining(filePath),
        })
      );
    } finally {
      holder.close();
    }
  });

  it("reclaims a stale lock whose pid is dead", () => {
    fs.writeFileSync(`${filePath}.lock`, "999999999\n0\n");
    const checkpoint = openCheckpoint(filePath);
    expect(checkpoint.entries().size).toBe(0);
    expect(fs.readFileSync(`${filePath}.lock`, "utf8")).toMatch(new RegExp(`^${process.pid}\\n`));
    checkpoint.close();
  });

  it("reclaims a stale lock after removing a leftover reclaim gate whose pid is dead", () => {
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, "999999999\n0\n");
    const gate = `${lockPath}.reclaim`;
    fs.mkdirSync(gate);
    fs.writeFileSync(path.join(gate, "pid"), "999999999\n");
    const checkpoint = openCheckpoint(filePath);
    expect(fs.readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid}\\n`));
    expect(fs.existsSync(gate)).toBe(false);
    checkpoint.close();
  });

  it("reclaims an unparseable lock file", () => {
    fs.writeFileSync(`${filePath}.lock`, "not-a-pid\n");
    const checkpoint = openCheckpoint(filePath);
    expect(checkpoint.entries().size).toBe(0);
    checkpoint.close();
  });

  it("does not reclaim an empty lock that may still be mid-create", () => {
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, "");
    expect(() => openCheckpoint(filePath)).toThrow(CheckpointLockedError);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("");
  });

  it("rejects a short write while creating the lock and removes the incomplete file", () => {
    vi.mocked(fs.writeSync).mockImplementation(() => 0);
    try {
      expect(() => openCheckpoint(filePath)).toThrow(/no bytes/);
      expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    } finally {
      vi.mocked(fs.writeSync).mockRestore();
    }
    const checkpoint = openCheckpoint(filePath);
    checkpoint.close();
  });

  it("removes the lock file if writing the lock fails after exclusive create", () => {
    vi.mocked(fs.writeSync).mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => openCheckpoint(filePath)).toThrow("disk full");
      expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    } finally {
      vi.mocked(fs.writeSync).mockRestore();
    }
    const checkpoint = openCheckpoint(filePath);
    checkpoint.close();
  });

  it("releases the lock if onCorruptFile throws during open", () => {
    fs.writeFileSync(filePath, "{not json");
    expect(() =>
      openCheckpoint(filePath, {
        onCorruptFile: () => {
          throw new Error("reject corrupt checkpoint");
        },
      })
    ).toThrow("reject corrupt checkpoint");
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    const checkpoint = openCheckpoint(filePath);
    expect(checkpoint.entries().size).toBe(0);
    checkpoint.close();
  });

  it("close() releases the lock without deleting checkpoint entries", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a", { attempt: 1 });
    checkpoint.flush();
    expect(fs.existsSync(`${filePath}.lock`)).toBe(true);

    checkpoint.close();
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);

    const reopened = openCheckpoint(filePath);
    expect(reopened.has("a")).toBe(true);
    reopened.close();
  });

  it("rejects record, flush, and clear after close, but still allows has and entries", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    checkpoint.flush();
    checkpoint.close();

    expect(checkpoint.has("a")).toBe(true);
    expect(checkpoint.entries().size).toBe(1);
    expect(() => checkpoint.record("b")).toThrow(/closed/);
    expect(() => checkpoint.flush()).toThrow(/closed/);
    expect(() => checkpoint.clear()).toThrow(/closed/);
  });

  it("keeps the lock if close cannot unlink the lock file", () => {
    const checkpoint = openCheckpoint(filePath);
    const lockPath = `${filePath}.lock`;
    const actualRm = fs.rmSync;
    vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (target === lockPath) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return actualRm(target, options);
    });
    try {
      expect(() => checkpoint.close()).toThrow(/operation not permitted/);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(() => checkpoint.record("a")).not.toThrow();
      expect(() => openCheckpoint(filePath)).toThrow(CheckpointLockedError);
    } finally {
      vi.mocked(fs.rmSync).mockRestore();
    }
    checkpoint.close();
  });

  it("close() is idempotent", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.close();
    expect(() => checkpoint.close()).not.toThrow();
    const reopened = openCheckpoint(filePath);
    reopened.close();
  });

  it("clear() wipes the file but keeps the lock so a second open still fails", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    checkpoint.flush();
    checkpoint.clear();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(true);
    expect(() => openCheckpoint(filePath)).toThrow(CheckpointLockedError);
    checkpoint.close();
    const reopened = openCheckpoint(filePath);
    expect(reopened.entries().size).toBe(0);
    reopened.close();
  });

  it("locks the path even when the checkpoint file does not exist", () => {
    const holder = openCheckpoint(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(true);
    expect(() => openCheckpoint(filePath)).toThrow(CheckpointLockedError);
    holder.close();
  });
});

describe("withCheckpointedBatch", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-batch-test-"));
    filePath = path.join(dir, "run.checkpoint.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records and flushes every item in the batch after persist succeeds", async () => {
    const checkpoint = openCheckpoint(filePath);
    const persisted: string[] = [];

    await withCheckpointedBatch(
      checkpoint,
      ["a", "b"],
      (item) => item,
      () => {
        persisted.push("done");
      }
    );

    expect(persisted).toEqual(["done"]);
    expect(checkpoint.has("a")).toBe(true);
    expect(checkpoint.has("b")).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("does not record or flush any item when persist throws", async () => {
    const checkpoint = openCheckpoint(filePath);

    await expect(
      withCheckpointedBatch(
        checkpoint,
        ["a"],
        (item) => item,
        () => {
          throw new Error("persist failed");
        }
      )
    ).rejects.toThrow("persist failed");

    expect(checkpoint.has("a")).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("runs persist before recording, not the other way around", async () => {
    const checkpoint = openCheckpoint(filePath);
    const order: string[] = [];

    await withCheckpointedBatch(
      checkpoint,
      ["a"],
      (item) => item,
      () => {
        // If the implementation ever recorded first, checkpoint.has("a") would
        // already be true here.
        order.push(checkpoint.has("a") ? "recorded-before-persist" : "persist");
      }
    );

    expect(order).toEqual(["persist"]);
  });
});
