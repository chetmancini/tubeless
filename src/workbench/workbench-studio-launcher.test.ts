import { describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import {
  WorkbenchStudioLauncher,
  type WorkbenchStudioRegistration,
} from "./workbench-studio-launcher.js";
import { captureIo } from "./workbench.test-support.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registration(
  execute: WorkbenchStudioRegistration["command"]["execute"]
): WorkbenchStudioRegistration {
  return {
    command: {
      execute,
      parseValues: (values) => ({ kind: "values", values }),
      plan: (controls) => ({
        dryRun: controls?.dryRun === true,
        errors: [],
        ok: true,
        pipelineId: "fixture",
        steps: [],
      }),
    },
    commandIo: captureIo("/tmp"),
    descriptor: { canPlan: true, id: "fixture", name: "Fixture", parameters: [] },
  };
}

function started(runId: string): PipelineTraceEvent {
  return {
    name: "pipeline.started",
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    pipelineId: "fixture",
    runId,
    timestampMs: 1,
    version: 2,
  };
}

describe("WorkbenchStudioLauncher", () => {
  it("counts pre-start work as busy and releases its response before draining on stop", async () => {
    const finished = deferred();
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_values, context) => {
      signal = context?.signal;
      await finished.promise;
    });
    const launcher = new WorkbenchStudioLauncher([registration(execute)], { export: vi.fn() });
    const response = launcher.launch("fixture", {});
    try {
      expect(launcher.isBusy()).toBe(true);
      expect(launcher.liveRunIds()).toEqual([]);
      launcher.stop();
      launcher.stop();
      await expect(response).resolves.toEqual({
        accepted: false,
        errors: ["The local studio is stopping."],
      });
      expect(signal?.aborted).toBe(true);
      expect(launcher.isBusy()).toBe(true);
      await expect(launcher.launch("fixture", {})).resolves.toMatchObject({ accepted: false });
      expect(execute).toHaveBeenCalledTimes(1);
      let drained = false;
      const drain = launcher.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      finished.resolve();
      await drain;
      expect(launcher.isBusy()).toBe(false);
    } finally {
      launcher.stop();
      finished.resolve();
      await launcher.drain();
    }
  });

  it("owns concurrent run ids and cancellation without closing the injected exporter", async () => {
    const first = deferred();
    const second = deferred();
    const signals = new Map<string, AbortSignal>();
    const exported: PipelineTraceEvent[] = [];
    const exporter = {
      export: (event: PipelineTraceEvent) => {
        exported.push(event);
      },
      close: vi.fn(),
    };
    const entry = registration(async (values, context) => {
      const runId = String(values.runId);
      signals.set(runId, context!.signal!);
      await context!.pipelineContext!.tracing!.exporter.export(started(runId));
      await (runId === "first" ? first : second).promise;
    });
    const launcher = new WorkbenchStudioLauncher([entry], exporter);
    try {
      await expect(launcher.launch("fixture", { runId: "first" })).resolves.toEqual({
        accepted: true,
        runId: "first",
      });
      await expect(launcher.launch("fixture", { runId: "second" })).resolves.toEqual({
        accepted: true,
        runId: "second",
      });
      expect(launcher.liveRunIds()).toEqual(["first", "second"]);
      expect(launcher.cancel("unknown")).toEqual({ cancelled: false });
      expect(launcher.cancel("first")).toEqual({ cancelled: true, runId: "first" });
      expect(signals.get("first")!.aborted).toBe(true);
      expect(signals.get("second")!.aborted).toBe(false);
      expect(launcher.isBusy()).toBe(true);
      launcher.stop();
      expect(signals.get("second")!.aborted).toBe(true);
      first.resolve();
      second.resolve();
      await launcher.drain();
      expect(launcher.liveRunIds()).toEqual([]);
      expect(launcher.isBusy()).toBe(false);
      expect(exported.map(({ runId }) => runId)).toEqual(["first", "second"]);
      expect(exporter.close).not.toHaveBeenCalled();
    } finally {
      launcher.stop();
      first.resolve();
      second.resolve();
      await launcher.drain();
    }
  });

  it.each(["error", "help", "throw"] as const)(
    "rejects %s parsing without admitting a run",
    async (kind) => {
      const execute = vi.fn(async () => undefined);
      const entry = registration(execute);
      entry.command.parseValues = () => {
        if (kind === "throw") throw new Error("Invalid values");
        return kind === "help"
          ? { kind: "help", helpText: "Help" }
          : { kind: "error", errors: ["Invalid values"], helpText: "Help" };
      };
      const exporter = { export: vi.fn() };
      const launcher = new WorkbenchStudioLauncher([entry], exporter);
      await expect(launcher.launch("fixture", {})).resolves.toMatchObject({ accepted: false });
      await expect(launcher.launch("missing", {})).resolves.toEqual({
        accepted: false,
        errors: ["Pipeline command not found."],
      });
      expect(launcher.isBusy()).toBe(false);
      expect(launcher.liveRunIds()).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(exporter.export).not.toHaveBeenCalled();
      launcher.stop();
      await launcher.drain();
    }
  );

  it("plans through the registered command without starting execution", () => {
    const execute = vi.fn(async () => undefined);
    const entry = registration(execute);
    const launcher = new WorkbenchStudioLauncher([entry], { export: vi.fn() });
    expect(launcher.commands).toEqual([entry.descriptor]);
    expect(launcher.plan("fixture", { dryRun: true })).toMatchObject({ dryRun: true, ok: true });
    expect(() => launcher.plan("missing", {})).toThrow("Pipeline planning is not available");
    expect(execute).not.toHaveBeenCalled();
  });
});
