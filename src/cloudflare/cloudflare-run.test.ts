import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { defineProject } from "../project/project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import {
  BatchingTraceExporter,
  MAX_RUN_DURATION_MS,
  RunObjectCore,
  runHostedJob,
  type RunJob,
  type StudioIngest,
} from "./cloudflare-run.js";

function schema<T>(validate: (value: unknown) => T | undefined): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      vendor: "test",
      version: 1,
      validate: (value) => {
        const result = validate(value);
        return result === undefined
          ? { issues: [{ message: "Expected at least 3 characters" }] }
          : { value: result };
      },
      jsonSchema: { input: () => ({ type: "object", properties: { name: { type: "string" } } }) },
    } as StandardSchemaV1<T, T>["~standard"],
  };
}
const nameSchema = schema((value) => {
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length >= 3 ? { name } : undefined;
});
const { step } = createSteps(nameSchema);
const greet = step("greet", { run: (_inputs, context) => `hi ${context.options.name}` });
const Greeting = definePipeline({ id: "greeting", steps: [greet], finalize: greet });
const commands = new Map(
  hostedProjectCommands(defineProject("p", [Greeting])).map((entry) => [entry.descriptor.id, entry])
);

function ingest() {
  const batches: { sequence: number; events: PipelineTraceEvent[] }[] = [];
  const failures: string[] = [];
  const studio: StudioIngest = {
    appendEvents: async (_launchId, sequence, events) => void batches.push({ sequence, events }),
    reportFailure: async (_launchId, message) => void failures.push(message),
  };
  return { studio, batches, failures };
}
const job = (values: Record<string, unknown>): RunJob => ({
  launchId: "l1",
  commandId: "greeting",
  values,
  maxRunDurationMs: 60_000,
});

// The run object forwards pipeline output to the console; keep test output quiet.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
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
    await exporter.export({
      version: 3,
      name: "pipeline.started",
      runId: "r",
      pipelineId: "p",
      timestampMs: 1,
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    });
    await exporter.flush();
    expect(sent).toEqual([0]);
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

  it("ignores duplicate starts and cancels only a live run", async () => {
    const storage = createFakeDurableStorage();
    const core = new RunObjectCore({ storage, commands, ingest: () => ingest().studio });
    await core.start(job({ name: "ada" }));
    await core.start(job({ name: "other" }));
    expect((await storage.get<RunJob>("job"))?.values).toEqual({ name: "ada" });
    expect(core.cancel()).toBe(false);
  });
});

describe("hosted job", () => {
  it("keeps the run duration cap below the 15 minute alarm wall time", () => {
    expect(MAX_RUN_DURATION_MS).toBe(840_000);
  });

  it("aborts the run when event delivery is exhausted", async () => {
    const controller = new AbortController();
    const failing: StudioIngest = {
      appendEvents: async () => {
        throw new Error("studio unreachable");
      },
      reportFailure: async () => {},
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        job: job({ name: "ada" }),
        commands,
        ingest: failing,
        controller,
      });
      await vi.runAllTimersAsync();
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ message: "studio unreachable" });
  });
});
