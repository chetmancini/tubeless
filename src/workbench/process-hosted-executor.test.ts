import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedRunCoordinator } from "../hosting/run-coordinator.js";
import { createStudioHost } from "../hosting/hosting-studio.js";
import type { HostedLaunchStore } from "../hosting/launch-store.js";
import { createLaunchRegistryFixture } from "../hosting/launch-registry.test-support.js";
import { commands, job, sideEffect } from "../hosting/run.test-support.js";
import { createProcessHostedExecutor } from "./process-hosted-executor.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
  sideEffect.mockClear();
});

function setup(filename?: string) {
  const fixture = createLaunchRegistryFixture(filename);
  cleanups.push(() => fixture.store.close());
  // Every operation crosses an asynchronous boundary. No SQL, alarm, KV or
  // synchronous read capability is visible to the coordinator.
  // SAFETY: retain every typed store operation unchanged except for a microtask delay.
  const launches: HostedLaunchStore = Object.fromEntries(
    Object.entries(fixture.launches).map(([key, operation]) => [
      key,
      async (...args: never[]) => {
        await Promise.resolve();
        return Reflect.apply(operation, fixture.launches, args);
      },
    ])
  ) as unknown as HostedLaunchStore;
  let coordinator!: HostedRunCoordinator;
  const output = { cwd: process.cwd(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
  const executor = createProcessHostedExecutor({ commands, output, ingest: () => coordinator });
  cleanups.push(() => executor.close());
  const scheduleReconcile = vi.fn(async () => {});
  coordinator = new HostedRunCoordinator(
    {
      commands,
      output,
      executor,
      maxRunDurationMs: 60_000,
      scheduleReconcile,
      startTimeoutMs: 1000,
    },
    launches
  );
  return { ...fixture, coordinator, executor, scheduleReconcile };
}

function request(path: string, body?: unknown) {
  return new Request(
    `https://studio.test${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://studio.test",
            "x-tubeless-studio-launch": "1",
          },
          body: JSON.stringify(body),
        }
  );
}

describe("process hosted executor through the shared coordinator", () => {
  it("launches through Studio and keeps completed history across a collector reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-hosted-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "runs.sqlite");
    const { coordinator, executor, launches } = setup(filename);
    const host = await createStudioHost({
      store: launches,
      launcher: coordinator,
      clientScript: "",
    });
    const response = await host.fetch(
      request("/api/commands/greeting/runs", { values: { name: "Ada" } })
    );
    expect(response.status).toBe(202);
    const result = (await response.json()) as { accepted: boolean; runId: string };
    expect(result.accepted).toBe(true);
    await executor.drain();
    expect(await coordinator.liveRunIds()).toEqual([]);
    const snapshot = await (await host.fetch(request("/api/snapshot"))).json();
    expect(snapshot.liveRunIds).toEqual([]);
    const events = await launches.listEvents();
    expect(events.find((event) => event.name === "pipeline.completed")?.payload.status).toBe(
      "completed"
    );
    await executor.close();
    await launches.close();
    const reopened = createLaunchRegistryFixture(filename);
    try {
      expect(await reopened.launches.listEvents()).toEqual(events);
      expect(await reopened.launches.launchIdForRun(result.runId)).toBeUndefined();
    } finally {
      reopened.store.close();
    }
  });

  it("cancels by run identity and drains the recorded terminal event", async () => {
    const { coordinator, executor, launches } = setup();
    const result = await coordinator.launch("waiting", { name: "Ada" });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("Expected a recorded run.");
    expect(await coordinator.liveRunIds()).toEqual([result.runId]);
    expect(await coordinator.cancel(result.runId)).toEqual({
      cancelled: true,
      runId: result.runId,
    });
    await executor.drain();
    expect(
      (await launches.listEvents()).find((event) => event.name === "pipeline.completed")?.payload
        .status
    ).toBe("cancelled");
    expect(await coordinator.cancel(result.runId)).toEqual({ cancelled: false });
  });

  it("prevents duplicate dispatch within its lifetime, including after completion", async () => {
    const { executor, launches } = setup();
    await launches.create("l1", "effect", Date.now());
    const run = { ...job({ name: "Ada" }), commandId: "effect" };
    await Promise.all([executor.start(run), executor.start(run)]);
    await executor.drain();
    await executor.start(run);
    await executor.drain();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(
      (await launches.listEvents()).filter((event) => event.name === "pipeline.started")
    ).toHaveLength(1);
    await executor.close();
    await expect(executor.start({ ...run, launchId: "l2" })).rejects.toThrow("closed");
  });

  it("refuses a terminal launch before executing user code", async () => {
    const { launches, executor } = setup();
    await launches.create("l1", "effect", Date.now());
    await launches.fail("l1", "No longer executable", Date.now());
    await executor.start({ ...job({ name: "Ada" }), commandId: "effect" });
    await executor.drain();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(await launches.listEvents()).toEqual([]);
  });

  it("protects admitted work from a delayed dispatch failure", async () => {
    const { launches, registry } = setup();
    await launches.create("l1", "effect", Date.now());
    expect(await launches.admit("l1")).toBe(true);
    await launches.failUnadmitted("l1", "Dispatch response was lost", Date.now());
    expect(registry.get("l1")?.state).toBe("starting");
    await launches.create("l2", "effect", Date.now());
    await launches.failUnadmitted("l2", "Never dispatched", Date.now());
    expect(await launches.admit("l2")).toBe(false);
  });

  it("records cancellation before closing and refuses subsequent dispatch", async () => {
    const { coordinator, executor, launches } = setup();
    await coordinator.launch("waiting", { name: "Ada" });
    await executor.close();
    expect(
      (await launches.listEvents()).find((event) => event.name === "pipeline.completed")?.payload
        .status
    ).toBe("cancelled");
    expect(await launches.liveRunIds()).toEqual([]);
  });
});
