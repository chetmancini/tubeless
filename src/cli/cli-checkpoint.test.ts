import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCheckpoint, type CheckpointStore } from "../node/checkpoint.js";
import { CliHelpRequested, CliValidationError, defineCommand } from "./cli.js";
import { testLog } from "./cli.test-support.js";

describe("defineCommand: checkpoint", () => {
  let dir: string;
  let checkpointPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-checkpoint-test-"));
    checkpointPath = path.join(dir, "run.checkpoint.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedCheckpoint(): void {
    const store = openCheckpoint(checkpointPath);
    store.record("a");
    store.flush();
  }

  it("starts fresh by default, clearing a pre-existing checkpoint before run is called", async () => {
    seedCheckpoint();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run([]);
    expect(seenHasA).toBe(false);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("--resume preserves existing entries and logs a resuming message", async () => {
    seedCheckpoint();
    const log = testLog();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run(["--resume"], { log });
    expect(seenHasA).toBe(true);
    expect(log.lines.some((l) => l.message.includes("Resuming from checkpoint"))).toBe(true);
  });

  it("warns when --resume is passed but no checkpoint file exists", async () => {
    const log = testLog();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run(["--resume"], { log });
    expect(seenHasA).toBe(false);
    expect(
      log.lines.some((l) => l.level === "warn" && l.message.includes("no checkpoint was found"))
    ).toBe(true);
  });

  it("defaultResume: true resumes without a flag; --no-resume forces a fresh run", async () => {
    seedCheckpoint();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath, defaultResume: true },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run([]);
    expect(seenHasA).toBe(true);

    seedCheckpoint();
    await command.run(["--no-resume"]);
    expect(seenHasA).toBe(false);
  });

  it("throws at definition time if a schema redeclares resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { resume: { type: "boolean" } as never },
        run: () => undefined,
      })
    ).toThrow(/"resume" is a reserved parameter/);
    expect(() =>
      defineCommand({
        params: { resume: { type: "boolean" } as never },
        run: () => undefined,
      })
    ).toThrow(/"resume" is a reserved parameter/);
  });

  it("throws at definition time if a param's flag collides with --resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { continue: { type: "boolean", flag: "resume" } },
        run: () => undefined,
      })
    ).toThrow(/--resume is a reserved flag/);
    expect(() =>
      defineCommand({
        params: { continue: { type: "boolean", flag: "resume" } },
        run: () => undefined,
      })
    ).toThrow(/--resume is a reserved flag/);
  });

  it("throws at definition time if a param's flag collides with --no-resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { continueFresh: { type: "boolean", flag: "no-resume" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
    expect(() =>
      defineCommand({
        params: { continueFresh: { type: "boolean", flag: "no-resume" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
  });

  it("throws at definition time if a param's derived name collides with --no-resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { noResume: { type: "boolean" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
    expect(() =>
      defineCommand({
        params: { noResume: { type: "boolean" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
  });

  it("does not clear the checkpoint after a successful dry run", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    await command.run(["--resume", "--dry-run"]);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("does not destructively clear a pre-existing checkpoint on a fresh (non-resume) dry run", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    await command.run(["--dry-run"]);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("previews an empty checkpoint on a fresh (non-resume) dry run, even though the file survives on disk", async () => {
    seedCheckpoint();
    let seenHasA: boolean | undefined;
    let seenEntriesSize: number | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
        seenEntriesSize = context.checkpoint?.entries().size;
      },
    });
    await command.run(["--dry-run"]);
    expect(seenHasA).toBe(false);
    expect(seenEntriesSize).toBe(0);
    // The on-disk file is untouched by the dry run (verified by the test above); this test
    // only asserts what `run` observes through `context.checkpoint`.
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("never writes to disk when run records and flushes during a fresh dry run with no existing checkpoint", async () => {
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
      },
    });
    await command.run(["--dry-run"]);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("never writes to disk when run records and flushes during a --resume dry run", async () => {
    seedCheckpoint();
    let seenHasB: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
        seenHasB = context.checkpoint?.has("b");
      },
    });
    await command.run(["--resume", "--dry-run"]);
    expect(seenHasB).toBe(true);
    expect(openCheckpoint(checkpointPath).has("b")).toBe(false);
  });

  it("never writes to disk when run records and flushes during a fresh dry run with an existing checkpoint", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
      },
    });
    await command.run(["--dry-run"]);
    const onDisk = openCheckpoint(checkpointPath);
    expect(onDisk.has("a")).toBe(true);
    expect(onDisk.has("b")).toBe(false);
  });

  it("clears the checkpoint after success by default", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    await command.run(["--resume"]);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("leaves the checkpoint alone after success when clearOnSuccess is false", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath, clearOnSuccess: false },
      params: {},
      run: () => undefined,
    });
    await command.run(["--resume"]);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("respects a caller-provided context.checkpoint override instead of opening the real file", async () => {
    const stub: CheckpointStore = {
      has: vi.fn(() => true),
      record: vi.fn(),
      entries: vi.fn(() => new Map()),
      flush: vi.fn(),
      clear: vi.fn(),
    };
    let received: CheckpointStore | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        received = context.checkpoint;
      },
    });
    await command.run([], { checkpoint: stub });
    expect(received).toBe(stub);
    expect(fs.existsSync(checkpointPath)).toBe(false);
    expect(stub.clear).toHaveBeenCalledTimes(1);
  });

  function fakeStore(seed: Iterable<[string, unknown]> = []): CheckpointStore {
    const entries = new Map(seed);
    return {
      has: (key) => entries.has(key),
      record: vi.fn((key, meta) => entries.set(key, meta)),
      entries: () => entries,
      flush: vi.fn(),
      clear: vi.fn(() => entries.clear()),
    };
  }

  it("clears a caller-provided checkpoint override on a fresh, non-dry-run run, same as a path-backed store", async () => {
    const stub = fakeStore([["a", undefined]]);
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run([], { checkpoint: stub });
    expect(seenHasA).toBe(false);
    expect(stub.clear).toHaveBeenCalled();
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("wraps a caller-provided checkpoint override in an in-memory view on a dry run", async () => {
    const stub = fakeStore([["a", undefined]]);
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run(["--resume", "--dry-run"], { checkpoint: stub });
    // The dry-run preview still reflects the caller's real entries...
    expect(seenHasA).toBe(true);
    // ...but nothing `run` writes reaches the caller's actual store.
    expect(stub.record).not.toHaveBeenCalled();
    expect(stub.flush).not.toHaveBeenCalled();
    expect(stub.has("b")).toBe(false);
  });

  it("never touches the checkpoint file on --help or invalid args", async () => {
    seedCheckpoint();
    const run = vi.fn();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: { limit: { type: "number" } },
      run,
    });
    await expect(command.run(["--help"])).rejects.toBeInstanceOf(CliHelpRequested);
    await expect(command.run(["--limit", "abc"])).rejects.toBeInstanceOf(CliValidationError);
    expect(run).not.toHaveBeenCalled();
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("main(): a thrown error from run leaves the checkpoint untouched", async () => {
    seedCheckpoint();
    const log = testLog();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => {
        throw new Error("boom");
      },
    });
    await command.main(["--resume"], { log });
    expect(process.exitCode).toBe(1);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
    process.exitCode = undefined;
  });

  it("main(): preserves a resumed checkpoint when SIGINT cleanup returns normally", async () => {
    seedCheckpoint();
    const log = testLog();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const onceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: async (_v, context) => {
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
      },
    });

    try {
      const runPromise = command.main(["--resume"], { log });
      await started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();
      await runPromise;

      expect(process.exitCode).toBe(130);
      expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
      expect(openCheckpoint(checkpointPath).has("b")).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
      onceSpy.mockRestore();
    }
  });

  it.each(["run", "execute", "main"] as const)(
    "%s(): preserves a resumed checkpoint when caller-triggered cancellation cleanup returns normally",
    async (entrypoint) => {
      seedCheckpoint();
      const controller = new AbortController();
      const log = testLog();
      let resolveStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const command = defineCommand({
        checkpoint: { path: checkpointPath },
        params: {},
        run: async (_v, context) => {
          resolveStarted?.();
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          context.checkpoint?.record("b");
          context.checkpoint?.flush();
        },
      });

      const runPromise =
        entrypoint === "execute"
          ? command.execute({ dryRun: false, resume: true }, { signal: controller.signal, log })
          : command[entrypoint](["--resume"], { signal: controller.signal, log });
      await started;
      controller.abort();
      await runPromise;

      const checkpoint = openCheckpoint(checkpointPath);
      expect(checkpoint.has("a")).toBe(true);
      expect(checkpoint.has("b")).toBe(true);
    }
  );

  it("lists --resume in help only for commands that support it", () => {
    const withCheckpoint = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    const withApplicationResume = defineCommand({
      params: {},
      resume: true,
      run: () => undefined,
    });
    const withoutCheckpoint = defineCommand({ params: {}, run: () => undefined });
    const withResult = withCheckpoint.parse(["--help"]);
    const applicationResult = withApplicationResume.parse(["--help"]);
    const withoutResult = withoutCheckpoint.parse(["--help"]);
    expect(withResult.kind === "help" && withResult.helpText).toContain("--resume");
    expect(applicationResult.kind === "help" && applicationResult.helpText).toContain("--resume");
    expect(withoutResult.kind === "help" && withoutResult.helpText).not.toContain("--resume");
  });

  it("rejects resume input when the command does not support it", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    expect(command.parse([])).toEqual({ kind: "values", values: { dryRun: false } });
    expect(command.parse(["--resume"])).toMatchObject({
      kind: "error",
      errors: ["Unknown option: --resume"],
    });
    expect(command.parse(["--no-resume"])).toMatchObject({
      kind: "error",
      errors: ["Unknown option: --no-resume"],
    });
    expect(command.parseValues({ resume: true })).toMatchObject({
      kind: "error",
      errors: ["Unknown parameter: resume"],
    });
  });

  it("parses application-owned resume behavior only when explicitly enabled", async () => {
    const seen: (boolean | undefined)[] = [];
    const command = defineCommand({
      params: {},
      resume: true,
      run: (values) => {
        seen.push(values.resume);
      },
    });

    expect(command.descriptor.parameters.map((parameter) => parameter.key)).toEqual([
      "dryRun",
      "resume",
    ]);
    expect(command.parse([])).toMatchObject({ kind: "values", values: { resume: false } });
    await command.run(["--resume"]);
    await command.run(["--no-resume"]);
    expect(seen).toEqual([true, false]);
  });
});
