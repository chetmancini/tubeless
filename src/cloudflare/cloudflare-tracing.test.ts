import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTraceContext } from "../project/project.js";
import type { PipelineTraceEvent, PipelineTraceExporterOptions } from "../tracing/tracing.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { RunObjectCore, runCloudflareJob } from "./cloudflare-run.js";
import { commands, completedStatus, ingest, job, sideEffect } from "../hosting/run.test-support.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare application exporters", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "composes project and app exporters through %s completion and waits for flush",
    async (status) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const projectEvents: PipelineTraceEvent[] = [];
      const appEvents: PipelineTraceEvent[] = [];
      const onExporterError = vi.fn();
      const broken = vi.fn(() => {
        throw new Error("destination down");
      });
      const projectTracing: PipelineTraceExporterOptions<ProjectTraceContext> = {
        exporters: vi.fn(() => [
          {
            export: (event: PipelineTraceEvent) => {
              projectEvents.push(event);
            },
          },
        ]),
      };
      const controller = new AbortController();
      const factory = vi.fn(() => [
        { export: broken },
        {
          export(event: PipelineTraceEvent) {
            appEvents.push(event);
          },
          flush: () => blocked,
        },
      ]);
      const { studio, batches, failures } = ingest();
      const entry = commands.get(status === "cancelled" ? "waiting" : "greeting")!;
      const launchJob = {
        ...job({ name: status === "failed" ? "ab" : "ada" }),
        commandId: entry.command.id,
      };
      let settled = false;
      const execution = runCloudflareJob({
        job: launchJob,
        commands: new Map([[entry.command.id, { ...entry, tracing: projectTracing }]]),
        controller,
        ingest: () => studio,
        tracing: { exporters: factory, onExporterError },
      }).then(() => {
        settled = true;
      });
      try {
        await vi.waitFor(() => expect(appEvents[0]?.name).toBe("pipeline.started"));
        if (status === "cancelled") controller.abort(new DOMException("Cancelled", "AbortError"));
        await vi.waitFor(() => expect(appEvents.at(-1)?.name).toBe("pipeline.completed"));
        expect(settled).toBe(false);
        release();
        await execution;
        expect(appEvents.at(-1)?.payload).toMatchObject({ status });
        expect(projectEvents).toEqual(appEvents);
        expect(batches.flatMap((batch) => batch.events)).toEqual(appEvents);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith({
          pipelineId: entry.command.id,
          cwd: "/tmp",
          signal: expect.any(AbortSignal),
          launchId: "l1",
        });
        expect(broken).toHaveBeenCalledTimes(1);
        expect(onExporterError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "destination down" })
        );
        expect(failures).toEqual([]);
      } finally {
        release();
        controller.abort();
        await execution;
      }
    }
  );

  it.each(["throw", "reject"] as const)(
    "isolates a project error handler that can %s while still calling the app handler",
    async (mode) => {
      const handlerError = new Error("project handler failed");
      const projectHandler = vi.fn(() => {
        if (mode === "throw") throw handlerError;
        return Promise.reject(handlerError);
      });
      const appHandler = vi.fn();
      const entry = commands.get("greeting")!;
      const { studio, batches, failures } = ingest();
      await runCloudflareJob({
        job: job({ name: "ada" }),
        commands: new Map([
          [
            entry.command.id,
            {
              ...entry,
              tracing: { exporters: () => [], onExporterError: projectHandler },
            },
          ],
        ]),
        controller: new AbortController(),
        ingest: () => studio,
        tracing: {
          exporters: () => [
            {
              export() {
                throw new Error("destination failed");
              },
            },
          ],
          onExporterError: appHandler,
        },
      });
      // The emitter observes handler rejections without delaying pipeline execution.
      await new Promise((resolve) => setImmediate(resolve));
      expect(projectHandler).toHaveBeenCalledOnce();
      expect(appHandler).toHaveBeenCalledOnce();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("onExporterError failed: project handler failed")
      );
      expect(completedStatus(batches)).toMatchObject({ status: "completed" });
      expect(failures).toEqual([]);
    }
  );

  it.each(["export", "flush"] as const)(
    "observes rejected app error-handler promises after an %s failure",
    async (operation) => {
      const onExporterError = vi.fn(async () => {
        throw new Error("app handler failed");
      });
      const { studio, batches, failures } = ingest();
      await runCloudflareJob({
        job: job({ name: "ada" }),
        commands,
        controller: new AbortController(),
        ingest: () => studio,
        tracing: {
          exporters: () => [
            {
              export() {
                if (operation === "export") throw new Error("destination failed");
              },
              flush() {
                if (operation === "flush") throw new Error("destination failed");
              },
            },
          ],
          onExporterError,
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(onExporterError).toHaveBeenCalledOnce();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("onExporterError failed: app handler failed")
      );
      expect(completedStatus(batches)).toMatchObject({ status: "completed" });
      expect(failures).toEqual([]);
    }
  );

  describe.each(["project", "app"] as const)("bounded %s destinations", (source) => {
    it.each(["export", "flush"] as const)(
      "retires a stuck %s after five seconds and observes its late rejection",
      async (operation) => {
        vi.useFakeTimers();
        let rejectLate!: (error: Error) => void;
        const blocked = new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        });
        const bad = {
          export: vi.fn(() => (operation === "export" ? blocked : undefined)),
          flush: vi.fn(() => (operation === "flush" ? blocked : undefined)),
        };
        const healthy: PipelineTraceEvent[] = [];
        const onExporterError = vi.fn();
        const tracing = {
          // Repeated references must retain composition's shared retirement semantics.
          exporters: () => [
            bad,
            bad,
            {
              export(event: PipelineTraceEvent) {
                healthy.push(event);
              },
            },
          ],
          onExporterError,
        };
        const entry = commands.get("greeting")!;
        const { studio, batches, failures } = ingest();
        const controller = new AbortController();
        let settled = false;
        const execution = runCloudflareJob({
          job: job({ name: "ada" }),
          commands: new Map([
            [
              entry.command.id,
              {
                ...entry,
                tracing: source === "project" ? tracing : undefined,
              },
            ],
          ]),
          controller,
          ingest: () => studio,
          tracing: source === "app" ? tracing : undefined,
        }).then(() => {
          settled = true;
        });
        try {
          await vi.advanceTimersByTimeAsync(0);
          expect(bad[operation]).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(4_999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await execution;
          expect(controller.signal.aborted).toBe(false);
          expect(bad[operation]).toHaveBeenCalledOnce();
          expect(onExporterError).toHaveBeenCalledWith(
            expect.objectContaining({ name: "TimeoutError" })
          );
          expect(healthy.at(-1)?.name).toBe("pipeline.completed");
          expect(batches.flatMap((batch) => batch.events)).toEqual(healthy);
          expect(completedStatus(batches)).toMatchObject({ status: "completed" });
          expect(failures).toEqual([]);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          rejectLate(new Error("destination rejected after timeout"));
          await vi.runAllTimersAsync();
          await execution;
          vi.useRealTimers();
        }
      }
    );
  });

  it.each(["export", "flush"] as const)(
    "bounds a stuck %s by the remaining run budget",
    async (operation) => {
      vi.useFakeTimers();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { studio, batches, failures } = ingest();
      const controller = new AbortController();
      let settled = false;
      const execution = runCloudflareJob({
        job: { ...job({ name: "ada" }), maxRunDurationMs: 25 },
        commands,
        controller,
        ingest: () => studio,
        tracing: {
          exporters: () => [
            {
              export: () => (operation === "export" ? blocked : undefined),
              flush: () => (operation === "flush" ? blocked : undefined),
            },
          ],
        },
      }).then(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(controller.signal.aborted).toBe(true);
        expect(settled).toBe(true);
        await execution;
        expect(completedStatus(batches)).toMatchObject({ status: "completed" });
        expect(failures).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release();
        await vi.runAllTimersAsync();
        await execution;
        vi.useRealTimers();
      }
    }
  );

  it("records cancellation despite a stuck optional exporter", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { studio, batches, failures } = ingest();
    const controller = new AbortController();
    let settled = false;
    const execution = runCloudflareJob({
      job: { ...job({ name: "ada" }), commandId: "waiting" },
      commands,
      controller,
      ingest: () => studio,
      tracing: { exporters: () => [{ export: () => blocked }] },
    }).then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException("Cancelled", "AbortError"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      await execution;
      expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
      expect(failures).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await vi.runAllTimersAsync();
      await execution;
      vi.useRealTimers();
    }
  });

  it("rolls back project exporters if the app factory fails, preserving the factory error", async () => {
    sideEffect.mockClear();
    const entry = commands.get("effect")!;
    let signal!: AbortSignal;
    const flush = vi.fn(() => {
      expect(signal.aborted).toBe(true);
      throw new Error("cleanup failed");
    });
    const exporter = { export: vi.fn(), flush };
    const { studio, batches, failures } = ingest();
    const storage = createFakeDurableStorage();
    const core = new RunObjectCore({
      storage,
      ingest: () => studio,
      commands: new Map([
        [
          entry.command.id,
          {
            ...entry,
            tracing: {
              exporters: (context) => {
                signal = context.signal;
                return [exporter, exporter];
              },
            },
          },
        ],
      ]),
      tracing: {
        exporters() {
          throw new Error("app factory failed");
        },
      },
    });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(flush).toHaveBeenCalledOnce();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
    expect(failures).toEqual(["Run host error: app factory failed"]);
    expect(await storage.get("job")).toBeUndefined();
  });

  it("bounds rollback when an earlier exporter's flush never settles", async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    const entry = commands.get("greeting")!;
    let signal!: AbortSignal;
    const flush = vi.fn(() => blocked);
    const { studio } = ingest();
    let failure: unknown;
    const execution = runCloudflareJob({
      job: job({ name: "ada" }),
      controller: new AbortController(),
      ingest: () => studio,
      commands: new Map([
        [
          entry.command.id,
          {
            ...entry,
            tracing: {
              exporters: (context) => {
                signal = context.signal;
                return [{ export: vi.fn(), flush }];
              },
            },
          },
        ],
      ]),
      tracing: {
        exporters() {
          throw new Error("app factory failed");
        },
      },
    }).catch((error) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(true);
      expect(flush).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(failure).toEqual(expect.objectContaining({ message: "app factory failed" }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rejectLate(new Error("late cleanup rejection"));
      await vi.runAllTimersAsync();
      await execution;
      vi.useRealTimers();
    }
  });

  it("creates no app exporters for refused launches and reports factory failure before side effects", async () => {
    sideEffect.mockClear();
    const exporters = vi.fn(() => {
      throw new Error("factory failed");
    });
    const { studio, failures } = ingest(async () => ({ admitted: false }));
    const core = new RunObjectCore({
      storage: createFakeDurableStorage(),
      commands,
      ingest: () => studio,
      tracing: { exporters },
    });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(exporters).not.toHaveBeenCalled();
    studio.admit = async () => ({ admitted: true });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(exporters).toHaveBeenCalledTimes(1);
    expect(failures).toEqual(["Run host error: factory failed"]);
    expect(sideEffect).not.toHaveBeenCalled();
  });
});
