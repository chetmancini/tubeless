import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { commands, completedStatus, ingest, job } from "./run.test-support.js";
import {
  runHostedJob,
  executeHostedRun,
  boundHostedEvent,
  HOSTED_TRACE_TEXT_LIMIT,
} from "./run.js";
import type { StudioIngest } from "./run-contract.js";

const output = {
  cwd: "/tmp",
  stdout: { write: (chunk: string) => void console.log(chunk.trimEnd()) },
  stderr: { write: (chunk: string) => void console.error(chunk.trimEnd()) },
};

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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("admitted execution history evidence", () => {
  const completed: PipelineTraceEvent = {
    version: 3,
    name: "pipeline.completed",
    runId: "r",
    pipelineId: "p",
    timestampMs: 2,
    payload: { dryRun: false, errorCount: 0, finalized: true, status: "completed", stepCount: 0 },
  };
  const entry = commands.get("greeting")!;
  function execution(events: PipelineTraceEvent[], flush = vi.fn(async () => {})) {
    return executeHostedRun({
      job: job({ name: "Ada" }),
      values: {},
      output,
      controller: new AbortController(),
      exporter: { export() {}, flush },
      entry: {
        ...entry,
        command: {
          ...entry.command,
          async execute(_values, context) {
            for (const event of events)
              await context!.pipelineContext!.tracing!.exporter.export(event);
          },
        },
      },
    });
  }

  it.each([
    { name: "start only", events: [startEvent], status: "partial" },
    {
      name: "child completion",
      events: [startEvent, { ...completed, parentRunId: "parent" }],
      status: "partial",
    },
    {
      name: "foreign completion",
      events: [startEvent, { ...completed, runId: "foreign" }],
      status: "partial",
    },
    { name: "matching root completion", events: [startEvent, completed], status: "complete" },
  ])("requires matching terminal root evidence: $name", async ({ events, status }) => {
    expect((await execution(events)).history.status).toBe(status);
  });

  it("waits for the final delivery barrier and returns its failure without a callback side channel", async () => {
    let reject!: (error: Error) => void;
    let draining!: () => void;
    const observed = new Promise<void>((resolve) => {
      draining = resolve;
    });
    const barrier = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const flush = vi.fn(() => {
      draining();
      return barrier;
    });
    let returned = false;
    const pending = execution([startEvent, completed], flush).then((result) => {
      returned = true;
      return result;
    });
    await observed;
    expect(returned).toBe(false);
    const error = new Error("delivery failed");
    reject(error);
    expect((await pending).history).toEqual({ status: "unconfirmed", error });
    expect(flush).toHaveBeenCalledOnce();
  });
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

describe("hosted job", () => {
  it("uses the target's output and cwd rather than a Cloudflare filesystem convention", async () => {
    const { studio, failures } = ingest();
    const stdout = vi.fn();
    const stderr = vi.fn();
    const cwd = "/container/workspace";
    const entry = commands.get("greeting")!;
    const contexts: { cwd?: string }[] = [];
    const adapted = {
      ...entry,
      command: {
        ...entry.command,
        execute: (
          values: Parameters<typeof entry.command.execute>[0],
          context: Parameters<typeof entry.command.execute>[1]
        ) => {
          contexts.push(context ?? {});
          return entry.command.execute(values, context);
        },
      },
    };
    await runHostedJob({
      job: job({ name: "ada" }),
      commands: new Map([["greeting", adapted]]),
      ingest: () => studio,
      controller: new AbortController(),
      output: { cwd, stdout: { write: stdout }, stderr: { write: stderr } },
    });
    expect(contexts).toEqual([expect.objectContaining({ cwd })]);
    expect(stdout).toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it("uses a target-supplied deadline longer than the Cloudflare alarm budget", async () => {
    vi.useFakeTimers();
    try {
      const { studio, batches, failures } = ingest();
      const controller = new AbortController();
      const running = runHostedJob({
        job: { ...job({ name: "ada" }), commandId: "waiting", maxRunDurationMs: 900_000 },
        commands,
        ingest: () => studio,
        controller,
        output,
      });
      await vi.advanceTimersByTimeAsync(840_000);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
      expect(controller.signal.aborted).toBe(true);
      expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
      expect(failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a run whose step logs more than the row limit", async () => {
    const { studio, batches, failures } = ingest();
    const controller = new AbortController();
    await runHostedJob({
      output,
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
        output,
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
    const attempts: { sequence: number; atMs: number }[] = [];
    const failing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async (_launchId, sequence) => {
        attempts.push({ sequence, atMs: Date.now() });
        throw new Error("studio unreachable");
      },
      reportFailure: async (_launchId, message) => void failures.push(message),
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        output,
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
    expect(attempts.map(({ sequence }) => sequence)).toEqual([0, 0, 0, 0, 0]);
    expect(attempts.map(({ atMs }) => atMs - attempts[0]!.atMs)).toEqual([0, 250, 750, 1750, 3750]);
    expect(failures).toEqual(["Run events could not be delivered to Studio: studio unreachable"]);
  });

  it("drains trusted delivery retries after execution cancellation", async () => {
    const { studio, batches, failures } = ingest();
    const controller = new AbortController();
    let first = true;
    const interrupted: StudioIngest = {
      ...studio,
      async appendEvents(launchId, sequence, events) {
        if (first) {
          first = false;
          controller.abort(new DOMException("Cancelled", "AbortError"));
          throw new Error("temporary delivery failure");
        }
        return studio.appendEvents(launchId, sequence, events);
      },
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        output,
        job: job({ name: "ada" }),
        commands,
        ingest: () => interrupted,
        controller,
      });
      await vi.runAllTimersAsync();
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(batches.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
    expect(failures).toEqual([]);
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
      output,
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
        output,
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
