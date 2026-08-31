import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCheckpoint, withCheckpointedBatch } from "./checkpoint.js";

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

    const reopened = openCheckpoint<{ attempt: number }>(filePath);
    expect(reopened.has("a")).toBe(true);
    expect(reopened.entries().get("a")).toEqual({ attempt: 1 });
  });

  it("persists a key recorded without metadata across a reload", () => {
    // record() without a `meta` argument stores `undefined`, which JSON.stringify
    // silently omits from a plain object — a reopened checkpoint must still see the
    // key as recorded, not treat it as never having been written.
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    checkpoint.flush();

    const reopened = openCheckpoint(filePath);
    expect(reopened.has("a")).toBe(true);
    expect(reopened.entries().size).toBe(1);
  });

  it("deletes the checkpoint file on clear", () => {
    const checkpoint = openCheckpoint(filePath);
    checkpoint.record("a");
    checkpoint.flush();
    expect(fs.existsSync(filePath)).toBe(true);

    checkpoint.clear();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(checkpoint.has("a")).toBe(false);
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
    expect(fs.readdirSync(dir)).toEqual([path.basename(filePath)]);
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
