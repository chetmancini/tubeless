import { createSteps, definePipeline } from "../core/pipeline.js";
import { definePipelineCommand } from "../cli/cli-pipeline-command.js";
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

describe("Studio application tracing", () => {
  it("records acknowledgements despite app exporter failures and drains each launch's flush", async () => {
    const release = deferred();
    const onExporterError = vi.fn();
    const destinations: PipelineTraceEvent[][] = [];
    const flushes: string[] = [];
    const factory = vi.fn(() => {
      const events: PipelineTraceEvent[] = [];
      destinations.push(events);
      return [
        {
          export() {
            throw new Error("app exporter failed");
          },
        },
        {
          export(event: PipelineTraceEvent) {
            events.push(event);
          },
          async flush() {
            await release.promise;
            flushes.push("flushed");
          },
        },
      ];
    });
    const { step } = createSteps();
    const work = step("work", { run: () => "ok" });
    const command = definePipelineCommand(definePipeline({ id: "fixture", steps: [work] }), {
      params: {},
      reporter: false,
    });
    const entry = {
      ...registration(command.execute),
      command,
      tracing: { exporters: factory, onExporterError },
    };
    const stored: PipelineTraceEvent[] = [];
    const launcher = new WorkbenchStudioLauncher([entry], {
      export: (event) => {
        stored.push(event);
      },
    });
    try {
      const first = await launcher.launch("fixture", {});
      const second = await launcher.launch("fixture", {});
      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(true);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenCalledWith({
        pipelineId: "fixture",
        cwd: "/tmp",
        signal: expect.any(AbortSignal),
      });
      expect(launcher.isBusy()).toBe(true);
      expect(flushes).toEqual([]);
      release.resolve();
      await launcher.drain();
      expect(flushes).toHaveLength(2);
      expect(destinations.map((events) => events.at(-1)?.name)).toEqual([
        "pipeline.completed",
        "pipeline.completed",
      ]);
      expect(new Set(destinations.map((events) => events[0]?.runId)).size).toBe(2);
      expect(stored.filter((event) => event.name === "pipeline.completed")).toHaveLength(2);
      expect(onExporterError).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      launcher.stop();
      await launcher.drain();
    }
  });

  it("rejects factory errors before execution and does not initialize exporters on parse errors", async () => {
    const execute = vi.fn(async () => undefined);
    const exporters = vi.fn(() => {
      throw new Error("factory failed");
    });
    const entry = { ...registration(execute), tracing: { exporters } };
    const launcher = new WorkbenchStudioLauncher([entry], { export: vi.fn() });
    expect(await launcher.launch("fixture", {})).toEqual({
      accepted: false,
      errors: ["factory failed"],
    });
    entry.command.parseValues = () => ({ kind: "error", errors: ["invalid"], helpText: "help" });
    expect(await launcher.launch("fixture", {})).toMatchObject({ accepted: false });
    expect(exporters).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(launcher.isBusy()).toBe(false);
  });
});

it("keeps Studio busy until pre-run exporter rollback finishes", async () => {
  const cleanup = deferred();
  let signal!: AbortSignal;
  const flush = vi.fn(() => cleanup.promise);
  const entry = {
    ...registration(async () => {
      throw new Error("command preparation failed");
    }),
    tracing: {
      exporters: (context: { signal: AbortSignal }) => {
        signal = context.signal;
        return [{ export: vi.fn(), flush }];
      },
    },
  };
  const launcher = new WorkbenchStudioLauncher([entry], { export: vi.fn() });
  const response = launcher.launch("fixture", {});
  try {
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(true);
    expect(launcher.isBusy()).toBe(true);
    cleanup.resolve();
    await expect(response).resolves.toMatchObject({ accepted: false });
    await launcher.drain();
    expect(launcher.isBusy()).toBe(false);
  } finally {
    cleanup.resolve();
    launcher.stop();
    await launcher.drain();
  }
});
