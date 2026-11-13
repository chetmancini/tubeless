import { describe, expect, it, vi } from "vitest";
import type { ProjectTraceContext } from "../project/pipeline-project.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createLaunchTracing } from "./launch-tracing.js";

const started: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.started",
  runId: "run",
  pipelineId: "test",
  timestampMs: 0,
  payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
};
const context = () => ({ pipelineId: "test", cwd: "/tmp", signal: new AbortController().signal });

describe("launch tracing ownership", () => {
  it("aborts partial factory setup and drains each returned destination once without masking errors", async () => {
    const input = context();
    const flushedSignals: boolean[] = [];
    let factoryContext!: ProjectTraceContext;
    const flush = vi.fn(() => {
      flushedSignals.push(factoryContext.signal.aborted);
    });
    const exporter = { export: vi.fn(), flush };
    const cleanupPartialFactory = vi.fn();
    const original = new Error("second factory failed");
    const builtin = { export: vi.fn(), flush: vi.fn() };
    const launch = createLaunchTracing({
      context: input,
      exporters: [builtin],
      configurations: [
        {
          exporters: (ctx) => {
            factoryContext = ctx;
            return [
              exporter,
              exporter,
              {
                export: vi.fn(),
                flush() {
                  throw new Error("cleanup failed");
                },
              },
            ];
          },
        },
        {
          exporters: (ctx) => {
            ctx.signal.addEventListener("abort", cleanupPartialFactory, { once: true });
            throw original;
          },
        },
      ],
    });
    expect(flush).not.toHaveBeenCalled();
    expect(() => launch.prepare()).toThrow(original);
    await launch.close();
    await launch.close();
    expect(factoryContext.signal.aborted).toBe(true);
    expect(input.signal.aborted).toBe(false);
    expect(flush).toHaveBeenCalledOnce();
    expect(flushedSignals).toEqual([true]);
    expect(cleanupPartialFactory).toHaveBeenCalledOnce();
    expect(builtin.flush).not.toHaveBeenCalled();
  });

  it("drains prepared exporters when command preparation never starts a run", async () => {
    const flush = vi.fn();
    let signal!: AbortSignal;
    const launch = createLaunchTracing({
      context: context(),
      exporters: [],
      configurations: [
        {
          exporters: (ctx) => {
            signal = ctx.signal;
            return [{ export: vi.fn(), flush }];
          },
        },
      ],
    });
    launch.prepare();
    await launch.close();
    expect(signal.aborted).toBe(true);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("leaves ordinary flushing and cancellation with the run", async () => {
    const controller = new AbortController();
    const flush = vi.fn();
    let signal!: AbortSignal;
    const launch = createLaunchTracing({
      context: { ...context(), signal: controller.signal },
      exporters: [],
      configurations: [
        {
          exporters: (ctx) => {
            signal = ctx.signal;
            return [{ export: vi.fn(), flush }];
          },
        },
      ],
    });
    const tracing = launch.prepare()!;
    await tracing.exporter.export(started);
    await tracing.exporter.flush?.();
    await launch.close();
    expect(flush).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("retains repeated destination identity across factories and wraps each once", async () => {
    const exporter = { export: vi.fn() };
    const wrapExporter = vi.fn((value) => value);
    const launch = createLaunchTracing({
      context: context(),
      exporters: [],
      wrapExporter,
      configurations: [{ exporters: () => [exporter] }, { exporters: () => [exporter] }],
    });
    await launch.prepare()!.exporter.export(started);
    await launch.close();
    expect(wrapExporter).toHaveBeenCalledOnce();
    expect(exporter.export).toHaveBeenCalledTimes(2);
  });
});
