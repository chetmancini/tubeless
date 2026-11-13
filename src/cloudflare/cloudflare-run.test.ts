import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import {
  commands,
  completedStatus,
  ingest,
  job,
  sideEffect,
} from "./cloudflare-run.test-support.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import {
  BatchingTraceExporter,
  RunObjectCore,
  runHostedJob,
  boundHostedEvent,
  HOSTED_TRACE_TEXT_LIMIT,
} from "./cloudflare-run.js";
import { MAX_RUN_DURATION_MS, type RunJob, type StudioIngest } from "./cloudflare-run-contract.js";

const startEvent: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.started",
  runId: "r",
  pipelineId: "p",
  timestampMs: 1,
  payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
};
const logEvent: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.log",
  runId: "r",
  pipelineId: "p",
  timestampMs: 1,
  payload: { level: "log", message: "x" },
};

// The run object forwards pipeline output to the console; keep test output quiet.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("hosted trace text", () => {
  it("returns a short event unchanged", () => {
    expect(boundHostedEvent(logEvent)).toBe(logEvent);
  });

  it("bounds long log messages without mutating the input", () => {
    const message = "x".repeat(200_000);
    const event: PipelineTraceEvent = { ...logEvent, payload: { level: "log", message } };
    const bounded = boundHostedEvent(event);
    expect(bounded.name).toBe("pipeline.log");
    if (bounded.name !== "pipeline.log") throw new Error("Expected a log event");
    expect(bounded.payload.message.length).toBeLessThan(66_000);
    expect(bounded.payload.message.startsWith(message.slice(0, HOSTED_TRACE_TEXT_LIMIT))).toBe(
      true
    );
    expect(bounded.payload.message.endsWith("[truncated 134464 characters]")).toBe(true);
    expect(event.payload.message).toBe(message);
  });

  it("bounds error messages and stacks without mutating the input", () => {
    const text = "x".repeat(200_000);
    const event: PipelineTraceEvent = {
      version: 3,
      name: "step.failed",
      runId: "r",
      pipelineId: "p",
      stepId: "s",
      timestampMs: 1,
      payload: { status: "failed" },
      error: {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        phase: "execution",
        message: text,
        stack: text,
      },
    };
    const bounded = boundHostedEvent(event);
    expect(bounded.name).toBe("step.failed");
    if (bounded.name !== "step.failed") throw new Error("Expected a failed step event");
    for (const value of [bounded.error.message, bounded.error.stack]) {
      expect(value?.length).toBeLessThan(66_000);
      expect(value?.startsWith(text.slice(0, HOSTED_TRACE_TEXT_LIMIT))).toBe(true);
      expect(value?.endsWith("[truncated 134464 characters]")).toBe(true);
    }
    expect(event.error.message).toBe(text);
    expect(event.error.stack).toBe(text);
  });

  it.each([0, HOSTED_TRACE_TEXT_LIMIT, HOSTED_TRACE_TEXT_LIMIT + 1])(
    "bounds progress and skip messages only above the limit (%i)",
    (length) => {
      const message = "x".repeat(length);
      const events: PipelineTraceEvent[] = [
        {
          version: 3,
          name: "step.running",
          runId: "r",
          pipelineId: "p",
          stepId: "s",
          attemptId: "a",
          timestampMs: 1,
          payload: { progress: { completed: 1, message } },
        },
        {
          version: 3,
          name: "step.skipped",
          runId: "r",
          pipelineId: "p",
          stepId: "s",
          timestampMs: 1,
          payload: { status: "skipped", reason: "policy", message },
        },
      ];
      for (const event of events) {
        const bounded = boundHostedEvent(event);
        if (length <= HOSTED_TRACE_TEXT_LIMIT) {
          expect(bounded).toBe(event);
        } else {
          expect(bounded).not.toBe(event);
          expect(bounded.payload).not.toBe(event.payload);
          if (bounded.name === "step.running") {
            expect(bounded.payload.progress?.message).toBe(
              `${"x".repeat(HOSTED_TRACE_TEXT_LIMIT)}… [truncated 1 characters]`
            );
          } else if (bounded.name === "step.skipped") {
            expect(bounded.payload.message).toBe(
              `${"x".repeat(HOSTED_TRACE_TEXT_LIMIT)}… [truncated 1 characters]`
            );
          }
        }
        if (event.name === "step.running") expect(event.payload.progress?.message).toBe(message);
        if (event.name === "step.skipped") expect(event.payload.message).toBe(message);
      }
    }
  );
});

describe("batching exporter", () => {
  it("flushes the top-level start immediately, numbers batches, and retries", async () => {
    const sent: number[] = [];
    let failOnce = true;
    const exporter = new BatchingTraceExporter(
      async (sequence) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient");
        }
        sent.push(sequence);
      },
      { maxEvents: 50, maxDelayMs: 10_000, retries: 2, retryDelayMs: 0, onFailure: () => {} }
    );
    await exporter.export(startEvent);
    expect(sent).toEqual([0]);
    await exporter.export(logEvent);
    await exporter.flush();
    expect(sent).toEqual([0, 1]);
  });

  it("flushes when maxEvents is reached", async () => {
    const sent: number[] = [];
    const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
      maxEvents: 2,
      maxDelayMs: 10_000,
      retries: 0,
      retryDelayMs: 0,
      onFailure: () => {},
    });
    await exporter.export(logEvent);
    expect(sent).toEqual([]);
    await exporter.export(logEvent);
    expect(sent).toEqual([0]);
  });

  it("flushes after maxDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
        maxEvents: 50,
        maxDelayMs: 100,
        retries: 0,
        retryDelayMs: 0,
        onFailure: () => {},
      });
      await exporter.export(logEvent);
      await vi.advanceTimersByTimeAsync(99);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends a later sequence after a delivery failed", async () => {
    const send = vi.fn(async (_sequence: number) => {
      throw new Error("down");
    });
    const exporter = new BatchingTraceExporter(send, {
      maxEvents: 1,
      maxDelayMs: 0,
      retries: 0,
      retryDelayMs: 0,
      onFailure: () => {},
    });
    await expect(exporter.export(logEvent)).rejects.toThrow("down");
    await expect(exporter.export(logEvent)).rejects.toThrow("down");
    await expect(exporter.flush()).rejects.toThrow("down");
    expect(send.mock.calls.map(([sequence]) => sequence)).toEqual([0]);
  });

  it("reports exhausted retries once", async () => {
    const onFailure = vi.fn();
    const exporter = new BatchingTraceExporter(
      async () => {
        throw new Error("down");
      },
      { maxEvents: 1, maxDelayMs: 0, retries: 1, retryDelayMs: 0, onFailure }
    );
    await expect(
      exporter.export({
        version: 3,
        name: "pipeline.log",
        runId: "r",
        pipelineId: "p",
        timestampMs: 1,
        payload: { level: "log", message: "x" },
      })
    ).rejects.toThrow("down");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe("run object", () => {
  it("executes a job once and clears its storage", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio, now: () => 1_000 });
    await core.start(job({ name: "ada" }));
    expect(storage.alarmAtMs()).toBe(1_000);
    await core.alarm();
    const names = batches.flatMap((batch) => batch.events.map((event) => event.name));
    expect(names[0]).toBe("pipeline.started");
    expect(names).toContain("pipeline.completed");
    expect(batches.map((batch) => batch.sequence)).toEqual([...batches.keys()]);
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
    expect(storage.alarmAtMs()).toBeUndefined();
  });

  it("records an options-schema rejection as a failed run rather than a host failure", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start(job({ name: "ab" }));
    await core.alarm();
    const events = batches.flatMap((batch) => batch.events);
    expect(events[0]?.name).toBe("pipeline.started");
    const completed = events.find((event) => event.name === "pipeline.completed");
    expect(completed?.payload).toMatchObject({ status: "failed" });
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
  });

  it("reports a command that is not registered", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "missing" });
    await core.alarm();
    expect(batches).toEqual([]);
    expect(failures).toEqual(["Pipeline command not found."]);
  });

  it("treats an alarm that finds its job running as a crashed attempt", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    await storage.put("job", job({ name: "ada" }));
    await storage.put("state", "running");
    await new RunObjectCore({ storage, commands, ingest: () => studio }).alarm();
    expect(batches).toEqual([]);
    expect(failures).toEqual(["The Cloudflare run host stopped before the run finished."]);
    expect(await storage.get("job")).toBeUndefined();
  });

  it("never executes a job that Studio does not admit", async () => {
    sideEffect.mockClear();
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest(async () => ({ admitted: false }));
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
    expect(storage.alarmAtMs()).toBeUndefined();
  });

  it("never executes a job whose admission could not be confirmed", async () => {
    sideEffect.mockClear();
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest(async () => {
      throw new Error("admission RPC lost");
    });
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
    expect(failures).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "admission RPC lost" })
    );
    expect(await storage.get("job")).toBeUndefined();
  });

  it("executes an admitted job", async () => {
    sideEffect.mockClear();
    const storage = createFakeDurableStorage();
    const { studio, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });

  it("ignores duplicate starts and cancels only a live run", async () => {
    const storage = createFakeDurableStorage();
    const core = new RunObjectCore({ storage, commands, ingest: () => ingest().studio });
    await core.start(job({ name: "ada" }));
    await core.start(job({ name: "other" }));
    expect((await storage.get<RunJob>("job"))?.values).toEqual({ name: "ada" });
    expect(core.cancel()).toBe(false);
  });
});

describe("run lifecycle", () => {
  it("cancels a live run and ends it cancelled", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "waiting" });
    const alarm = core.alarm();
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
    expect(core.cancel()).toBe(true);
    expect(core.cancel()).toBe(false);
    await alarm;
    expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
    expect(core.cancel()).toBe(false);
  });

  it("aborts a run that exceeds its deadline", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "waiting", maxRunDurationMs: 50 });
    await core.alarm();
    expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
    expect(failures).toEqual([]);
  });

  it("caps the watchdog alarm at the maximum run duration", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio, now: () => 1_000 });
    await core.start({
      ...job({ name: "ada" }),
      commandId: "waiting",
      maxRunDurationMs: 100 * MAX_RUN_DURATION_MS,
    });
    const alarm = core.alarm();
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
    expect(storage.alarmAtMs()).toBe(1_000 + MAX_RUN_DURATION_MS + 60_000);
    core.cancel();
    await alarm;
  });

  it("reports a command that exits before recording a run", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const real = commands.get("greeting")!;
    const throwing = new Map([
      [
        "greeting",
        {
          descriptor: real.descriptor,
          command: {
            ...real.command,
            execute: async () => {
              throw new Error("boom before start");
            },
          },
        },
      ],
    ]);
    const core = new RunObjectCore({ storage, commands: throwing, ingest: () => studio });
    await core.start(job({ name: "ada" }));
    await core.alarm();
    expect(batches).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/before recording a run/);
    expect(failures[0]).toContain("boom before start");
  });

  it("never rethrows from alarm even when cleanup fails", async () => {
    const storage = createFakeDurableStorage();
    const { studio } = ingest();
    const broken = {
      ...storage,
      deleteAll: async () => {
        throw new Error("storage down");
      },
    };
    const core = new RunObjectCore({ storage: broken, commands, ingest: () => studio });
    await core.start(job({ name: "ada" }));
    await expect(core.alarm()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "storage down" })
    );
  });

  it("never rethrows from alarm when the ingest factory throws", async () => {
    const storage = createFakeDurableStorage();
    const core = new RunObjectCore({
      storage,
      commands,
      ingest: () => {
        throw new Error("no binding");
      },
    });
    await core.start(job({ name: "ada" }));
    await expect(core.alarm()).resolves.toBeUndefined();
  });
});

describe("hosted job", () => {
  it("keeps the run duration cap below the 15 minute alarm wall time", () => {
    expect(MAX_RUN_DURATION_MS).toBe(840_000);
  });

  it("delivers a run whose step logs more than the row limit", async () => {
    const { studio, batches, failures } = ingest();
    const controller = new AbortController();
    await runHostedJob({
      job: { ...job({ name: "ada" }), commandId: "noisy" },
      commands,
      ingest: () => studio,
      controller,
    });
    expect(controller.signal.aborted).toBe(false);
    expect(failures).toEqual([]);
    const events = batches.flatMap((batch) => batch.events);
    expect(events.some((event) => event.name === "pipeline.log")).toBe(true);
    expect(
      events.some(
        (event) => event.name === "pipeline.completed" && event.payload.status === "completed"
      )
    ).toBe(true);
    for (const event of events) expect(JSON.stringify(event).length).toBeLessThan(1_000_000);
  });

  it("uses a fresh Studio stub for every delivery attempt", async () => {
    const controller = new AbortController();
    const { studio, batches, failures } = ingest();
    let failFirstAppend = true;
    const factory = vi.fn((): StudioIngest => {
      let broken = false;
      const check = () => {
        if (broken) throw new Error("broken stub");
      };
      return {
        admit: async (launchId) => {
          check();
          return studio.admit(launchId);
        },
        appendEvents: async (launchId, sequence, events) => {
          check();
          if (failFirstAppend) {
            failFirstAppend = false;
            broken = true;
            throw new Error("Studio reset");
          }
          return studio.appendEvents(launchId, sequence, events);
        },
        reportFailure: async (launchId, message) => {
          check();
          return studio.reportFailure(launchId, message);
        },
      };
    });
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        job: job({ name: "ada" }),
        commands,
        ingest: factory,
        controller,
      });
      await vi.runAllTimersAsync();
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(controller.signal.aborted).toBe(false);
    expect(batches.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(factory.mock.calls.length).toBeGreaterThan(2);
  });

  it("aborts the run and tells Studio when event delivery is exhausted", async () => {
    const controller = new AbortController();
    const { failures } = ingest();
    const failing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async () => {
        throw new Error("studio unreachable");
      },
      reportFailure: async (_launchId, message) => void failures.push(message),
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        job: job({ name: "ada" }),
        commands,
        ingest: () => failing,
        controller,
      });
      await vi.runAllTimersAsync();
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ message: "studio unreachable" });
    expect(failures).toEqual(["Run events could not be delivered to Studio: studio unreachable"]);
  });

  it("stops the run without retrying when Studio refuses its events", async () => {
    const controller = new AbortController();
    const sequences: number[] = [];
    const failures: string[] = [];
    const refusing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async (_launchId, sequence) => {
        sequences.push(sequence);
        return { accepted: false };
      },
      reportFailure: async (_launchId, message) => void failures.push(message),
    };
    await runHostedJob({
      job: { ...job({ name: "ada" }), commandId: "waiting" },
      commands,
      ingest: () => refusing,
      controller,
    });
    expect(controller.signal.reason).toMatchObject({
      message: "Studio closed this launch; stopping the run.",
    });
    expect(sequences[0]).toBe(0);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(failures).toEqual([]);
  });

  it("logs instead of throwing when the delivery failure report also fails", async () => {
    const failing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async () => {
        throw new Error("studio unreachable");
      },
      reportFailure: async () => {
        throw new Error("report failed");
      },
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        job: job({ name: "ada" }),
        commands,
        ingest: () => failing,
        controller: new AbortController(),
      });
      await vi.runAllTimersAsync();
      await expect(running).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "report failed" })
    );
  });
});
