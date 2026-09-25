import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerThreadAdapter, type WorkerThreadAdapter } from "tubeless/node";
import { createSteps, definePipeline, type PipelineStepContext } from "../core/pipeline.js";
import { defer } from "../core/child-pipeline.test-support.js";
import { standardSchema } from "../core/pipeline.test-support.js";

const adapters: WorkerThreadAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function adapter(
  source: string,
  options: { poolSize?: number; cancelTimeoutMs?: number; exportName?: string } = {}
) {
  const value = createWorkerThreadAdapter({
    module: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    exportName: "work",
    ...options,
  });
  adapters.push(value);
  return value;
}

function context(
  overrides: Partial<PipelineStepContext<object>> = {}
): PipelineStepContext<object> {
  return {
    attemptId: "attempt",
    cwd: process.cwd(),
    dryRun: false,
    options: {},
    runId: "run",
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: Date.now,
    sleep: async () => {},
    reportAttempt: () => {},
    reportProgress: vi.fn(),
    recordArtifact: vi.fn(),
    ...overrides,
  };
}

describe("worker thread adapter", () => {
  it("runs synchronous handlers on separate threads, caps the pool, and reuses workers", async () => {
    const full = defer();
    let started = 0;
    const shared = new SharedArrayBuffer(16);
    const state = new Int32Array(shared);
    const pool = adapter(
      `
      import { threadId, isMainThread } from "node:worker_threads";
      export function work({ shared, index }, context) {
        const state = new Int32Array(shared);
        const active = Atomics.add(state, 0, 1) + 1;
        let previous;
        do { previous = Atomics.load(state, 1); }
        while (active > previous && Atomics.compareExchange(state, 1, previous, active) !== previous);
        context.reportProgress({ completed: 0, message: "started" });
        Atomics.wait(state, 2, 0);
        Atomics.sub(state, 0, 1);
        Atomics.add(state, 3, 1);
        return { threadId, isMainThread, index };
      }
    `,
      { poolSize: 2 }
    );
    const runs = Array.from({ length: 5 }, (_, index) =>
      pool.invoke(
        { shared, index },
        context({
          reportProgress: () => {
            if (++started === 2) full.resolve();
          },
        })
      )
    );
    try {
      // Receiving both messages while handlers are blocked proves the parent event loop is free.
      await full.promise;
      expect(Atomics.load(state, 0)).toBe(2);
      expect(started).toBe(2);
    } finally {
      Atomics.store(state, 2, 1);
      Atomics.notify(state, 2);
    }
    const values = (await Promise.all(runs)) as {
      threadId: number;
      isMainThread: boolean;
      index: number;
    }[];
    expect(new Set(values.map(({ threadId }) => threadId)).size).toBe(2);
    expect(values.every(({ isMainThread }) => !isMainThread)).toBe(true);
    expect(values.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4]);
    expect([...state]).toEqual([0, 2, 1, 5]);
  });

  it("clones inputs and outputs and forwards only the explicit worker context", async () => {
    const pool = adapter(`export function work(payload, context) {
      payload.bytes[0] = 9;
      context.log.log("value=%d", payload.date.getUTCFullYear());
      context.log.warn("warning");
      context.log.error("detail");
      context.reportProgress({ completed: 1, total: 2, message: "half" });
      const { log, reportProgress, signal, ...metadata } = context;
      return { payload, metadata, aborted: signal.aborted };
    }`);
    const ctx = context({ correlationId: "job", parentRunId: "parent", dryRun: true });
    const payload = {
      bytes: new Uint8Array([1, 2]),
      date: new Date("2020-01-01"),
      map: new Map([["key", 3]]),
    };
    const result = await pool.invoke(payload, ctx);
    expect(payload.bytes[0]).toBe(1);
    expect(result).toEqual({
      payload: { ...payload, bytes: new Uint8Array([9, 2]) },
      metadata: {
        attemptId: "attempt",
        correlationId: "job",
        parentRunId: "parent",
        cwd: process.cwd(),
        dryRun: true,
        runId: "run",
      },
      aborted: false,
    });
    expect(ctx.log.log).toHaveBeenCalledWith("value=2020");
    expect(ctx.log.warn).toHaveBeenCalledWith("warning");
    expect(ctx.log.error).toHaveBeenCalledWith("detail");
    expect(ctx.reportProgress).toHaveBeenCalledWith({ completed: 1, total: 2, message: "half" });
  });

  it("rejects non-cloneable input/output and can run again", async () => {
    const pool = adapter(
      'export function work(value) { return value === "bad" ? () => {} : value; }'
    );
    await expect(pool.invoke(() => {}, context())).rejects.toMatchObject({
      name: "DataCloneError",
    });
    await expect(pool.invoke("bad", context())).rejects.toMatchObject({ name: "DataCloneError" });
    await expect(pool.invoke(7, context())).resolves.toBe(7);
  });

  it("drops telemetry retained by a finished invocation", async () => {
    const pool = adapter(`
      let previous;
      export function work(_, ctx) {
        previous?.log.log("stale");
        previous?.reportProgress({ completed: 99 });
        ctx.log.log("current");
        ctx.reportProgress({ completed: 1 });
        previous = ctx;
      }
    `);
    const first = context();
    const second = context();
    await pool.invoke(null, first);
    await pool.invoke(null, second);
    for (const ctx of [first, second]) {
      expect(ctx.log.log).toHaveBeenCalledExactlyOnceWith("current");
      expect(ctx.reportProgress).toHaveBeenCalledExactlyOnceWith({ completed: 1 });
    }
  });

  it("preserves error names, stacks, codes and bounded causes without poisoning the worker", async () => {
    const pool = adapter(`export function work(value) {
      if (value) {
        const error = new Error("resize failed", { cause: new TypeError("invalid image") });
        error.name = "ResizeError"; error.code = "BAD_IMAGE"; throw error;
      }
      return "ok";
    }`);
    await expect(pool.invoke(true, context())).rejects.toMatchObject({
      name: "ResizeError",
      message: "resize failed",
      code: "BAD_IMAGE",
      stack: expect.stringContaining("resize failed"),
      cause: { name: "TypeError", message: "invalid image" },
    });
    await expect(pool.invoke(false, context())).resolves.toBe("ok");
  });

  it.each([
    "throw new Error('module failed')",
    "export const work = 3",
    "export const missing = 1",
  ])("rejects startup/export failures: %s", async (source) => {
    const pool = adapter(source);
    const results = await Promise.allSettled([
      pool.invoke(1, context()),
      pool.invoke(2, context()),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  });

  it.each([0, 7])(
    "rejects an unexpected exit %s and replaces the worker for queued work",
    async (code) => {
      const pool = adapter(
        `export function work(value) { if (value) process.exit(${code}); return 42; }`
      );
      const failure = pool.invoke(true, context());
      const success = pool.invoke(false, context());
      await expect(failure).rejects.toThrow(`exit code ${code}`);
      await expect(success).resolves.toBe(42);
    }
  );

  it("cancels queued work without invoking it and snapshots queued payloads", async () => {
    const started = defer();
    const shared = new SharedArrayBuffer(4);
    const pool = adapter(`export function work(payload, ctx) {
      if (payload.shared) { ctx.reportProgress({ completed: 0 }); Atomics.wait(new Int32Array(payload.shared), 0, 0); }
      return payload.value;
    }`);
    const first = pool.invoke(
      { shared, value: 1 },
      context({ reportProgress: () => started.resolve() })
    );
    await started.promise;
    const controller = new AbortController();
    const never = vi.fn();
    const queued = pool.invoke(
      { value: 2 },
      context({ signal: controller.signal, reportProgress: never })
    );
    const payload = { value: 3 };
    const last = pool.invoke(payload, context());
    payload.value = 99;
    controller.abort(new Error("remove queued"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError", message: "remove queued" });
    expect(never).not.toHaveBeenCalled();
    Atomics.store(new Int32Array(shared), 0, 1);
    Atomics.notify(new Int32Array(shared), 0);
    await expect(first).resolves.toBe(1);
    await expect(last).resolves.toBe(3);
  });

  it("allows cooperative cancellation cleanup and then reuses the worker", async () => {
    const started = defer();
    const shared = new SharedArrayBuffer(4);
    const controller = new AbortController();
    let thread = "";
    const pool = adapter(
      `
      import { threadId } from "node:worker_threads";
      export async function work(shared, ctx) {
        if (!shared) return threadId;
        ctx.reportProgress({ completed: 0, message: String(threadId) });
        await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
        Atomics.store(new Int32Array(shared), 0, ctx.signal.reason.message === "cancel work" ? 1 : -1);
        return "ignored";
      }
    `,
      { cancelTimeoutMs: 10_000 }
    );
    const result = pool.invoke(
      shared,
      context({
        signal: controller.signal,
        reportProgress: ({ message }) => {
          thread = message!;
          started.resolve();
        },
      })
    );
    await started.promise;
    controller.abort(new Error("cancel work"));
    await expect(result).rejects.toMatchObject({ name: "AbortError", message: "cancel work" });
    expect(Atomics.load(new Int32Array(shared), 0)).toBe(1);
    await expect(pool.invoke(null, context())).resolves.toBe(Number(thread));
  });

  it("terminates a blocked CPU worker on cancellation and replaces it before queued work runs", async () => {
    const started = defer();
    const shared = new SharedArrayBuffer(4);
    const controller = new AbortController();
    let thread = "";
    const pool = adapter(
      `
      import { threadId } from "node:worker_threads";
      export function work(shared, ctx) {
        if (!shared) return threadId;
        ctx.reportProgress({ completed: 0, message: String(threadId) });
        Atomics.wait(new Int32Array(shared), 0, 0);
        Atomics.store(new Int32Array(shared), 0, 2);
        return threadId;
      }
    `,
      { cancelTimeoutMs: 0 }
    );
    const result = pool.invoke(
      shared,
      context({
        signal: controller.signal,
        reportProgress: ({ message }) => {
          thread = message!;
          started.resolve();
        },
      })
    );
    await started.promise;
    const next = pool.invoke(null, context());
    controller.abort(new Error("stop CPU"));
    await expect(result).rejects.toMatchObject({ name: "AbortError", message: "stop CPU" });
    // A settled cancellation guarantees the thread has exited, so releasing this barrier cannot resume it.
    Atomics.store(new Int32Array(shared), 0, 1);
    Atomics.notify(new Int32Array(shared), 0);
    expect(await next).not.toBe(Number(thread));
    expect(Atomics.load(new Int32Array(shared), 0)).toBe(1);
  });

  it("closes active and queued invocations, rejects new work, and is idempotent", async () => {
    const started = defer();
    const pool = adapter(`export function work(_, ctx) {
      ctx.reportProgress({ completed: 0 }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }`);
    const active = pool.invoke(null, context({ reportProgress: () => started.resolve() }));
    const queued = pool.invoke(null, context());
    const settled = Promise.allSettled([active, queued]);
    await started.promise;
    const closing = pool.close();
    expect(pool.close()).toBe(closing);
    await closing;
    expect(await settled).toMatchObject([
      { status: "rejected", reason: { name: "AbortError" } },
      { status: "rejected", reason: { name: "AbortError" } },
    ]);
    await expect(pool.invoke(null, context())).rejects.toThrow("closed");
  });

  it("handles pre-abort and an abort during payload cloning", async () => {
    const pool = adapter('export function work() { throw new Error("must not start"); }');
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await expect(pool.invoke(null, context({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = new AbortController();
    await expect(
      pool.invoke(
        {
          get value() {
            second.abort();
            return 1;
          },
        },
        context({ signal: second.signal })
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a call if payload cloning closes the adapter", async () => {
    const pool = adapter("export function work() { return 1; }");
    await expect(
      pool.invoke(
        {
          get value() {
            void pool.close();
            return 1;
          },
        },
        context()
      )
    ).rejects.toThrow("closed");
  });

  it("uses fromRemote validation, progress, dry-run and failure semantics", async () => {
    const pool = adapter(`export function work(value, ctx) {
      ctx.log.log("working"); ctx.reportProgress({ completed: 1 });
      return ctx.dryRun ? 4 : value;
    }`);
    const { fromRemote, step } = createSteps();
    const remote = fromRemote("worker", {
      adapter: pool,
      mapInput: () => "invalid",
      outputSchema: standardSchema<unknown, number>((value) =>
        typeof value === "number" ? { value } : { issues: [{ message: "Expected number" }] }
      ),
    });
    const consume = vi.fn(({ worker }: { worker: number }) => worker * 2);
    const pipeline = definePipeline({
      id: "worker-pipeline",
      steps: [remote, step("consume", { dependsOn: [remote], run: consume })],
    });
    expect(pipeline.plan().steps[0]?.remote?.engine).toBe("node:worker_threads");
    const invalid = await pipeline.run({});
    expect(invalid.errors[0]?.code).toBe("TUBELESS_STEP_OUTPUT_VALIDATION_FAILED");
    expect(consume).not.toHaveBeenCalled();
    await expect(pipeline.runOrThrow({}, { dryRun: true })).resolves.toBe(8);
  });

  it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid poolSize %s", (poolSize) => {
    expect(() => adapter("", { poolSize })).toThrow(/poolSize/);
  });
  it.each([-1, Infinity, NaN, 2_147_483_648])(
    "rejects invalid cancellation grace %s",
    (cancelTimeoutMs) => {
      expect(() => adapter("", { cancelTimeoutMs })).toThrow(/cancelTimeoutMs/);
    }
  );
});
