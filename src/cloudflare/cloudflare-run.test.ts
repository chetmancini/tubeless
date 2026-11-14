import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, completedStatus, ingest, job, sideEffect } from "../hosting/run.test-support.js";
import type { RunJob } from "../hosting/run-contract.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { RunObjectCore, runCloudflareJob } from "./cloudflare-run.js";
import { MAX_RUN_DURATION_MS } from "./cloudflare-run-contract.js";

// The run object forwards pipeline output to the console; keep test output quiet.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
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
  it("caps the shared runner's cooperative deadline at the Cloudflare maximum", async () => {
    vi.useFakeTimers();
    try {
      const { studio, batches } = ingest();
      const controller = new AbortController();
      const running = runCloudflareJob({
        job: {
          ...job({ name: "ada" }),
          commandId: "waiting",
          maxRunDurationMs: MAX_RUN_DURATION_MS * 100,
        },
        commands,
        ingest: () => studio,
        controller,
      });
      await vi.advanceTimersByTimeAsync(MAX_RUN_DURATION_MS);
      await running;
      expect(controller.signal.aborted).toBe(true);
      expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

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
