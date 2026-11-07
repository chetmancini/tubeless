import { describe, expect, it, vi } from "vitest";
import {
  projectPipelineRunStore,
  type PipelineRunEventQuery,
  type StoredPipelineEvent,
} from "../../run-store/run-store.js";
import { memoryStore, recordedRun, storedEvent } from "./events.test-support.js";
import { StudioRunDetails } from "./run-details.js";

function runEvent(
  id: number,
  name: StoredPipelineEvent["name"],
  fields: Record<string, unknown> = {}
): StoredPipelineEvent {
  return storedEvent({
    id,
    name,
    pipelineId: "fixture",
    runId: "run",
    timestampMs: id,
    version: 2,
    ...fields,
  });
}

describe("Studio run detail retention", () => {
  it("matches the run-store projection across pages and incremental refreshes", async () => {
    const step = { attemptId: "write-1", stepId: "write" };
    const events = [
      ...recordedRun(),
      runEvent(3, "pipeline.started", { pipelineId: "other", runId: "other" }),
      runEvent(4, "step.planned", {
        stepId: "write",
        payload: {
          dependencies: [],
          dryRun: "run",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [],
          skipAfterFailureOf: [],
        },
      }),
      runEvent(5, "step.running", step),
      runEvent(6, "step.artifact", {
        ...step,
        payload: { operation: "write", preview: false, artifact: { id: "report" } },
      }),
    ];
    const store = memoryStore(events);
    const listEvents = vi.fn(async (query?: PipelineRunEventQuery) =>
      (await store.listEvents(query)).slice(0, 2)
    );
    const details = new StudioRunDetails({ listEvents });
    const projected = () =>
      projectPipelineRunStore(events, 0).runs.find(({ runId }) => runId === "run");

    expect(await details.read("run")).toEqual(projected());
    expect(listEvents.mock.calls.length).toBeGreaterThan(2);

    events.push(
      runEvent(7, "step.complete", { ...step, durationMs: 2, payload: { status: "completed" } }),
      runEvent(8, "pipeline.log", { payload: { level: "log", message: "done" } }),
      runEvent(9, "pipeline.completed", { durationMs: 8 })
    );
    const refreshed = await details.read("run");
    expect(refreshed).toEqual(projected());
    expect(refreshed).toMatchObject({ eventCount: 8, logCount: 2, status: "completed" });
  });

  it("returns nothing for unseen runs and reuses a cached snapshot when no events follow", async () => {
    const store = memoryStore(recordedRun());
    const listEvents = vi.fn(store.listEvents);
    const details = new StudioRunDetails({ listEvents });

    expect(await details.read("missing")).toBeUndefined();
    expect(await details.read("missing")).toBeUndefined();
    expect(listEvents.mock.calls.map(([query]) => query?.afterId)).toEqual([undefined, undefined]);

    const first = await details.read("run");
    listEvents.mockClear();
    expect(await details.read("run")).toBe(first);
    expect(listEvents.mock.calls[0][0]).toMatchObject({ afterId: 2, runId: "run" });
  });

  it("resumes an interrupted cached refresh without losing or duplicating appended pages", async () => {
    const events = recordedRun();
    const store = memoryStore(events);
    const listEvents = vi.fn(store.listEvents);
    const details = new StudioRunDetails({ listEvents });
    await details.read("run");
    events.push(
      storedEvent({
        id: 3,
        name: "pipeline.log",
        pipelineId: "fixture",
        runId: "run",
        timestampMs: 3,
        version: 2,
        payload: { level: "log", message: "new page" },
      })
    );
    const failure = new Error("tail unavailable");
    listEvents
      .mockImplementationOnce((query) => store.listEvents(query))
      .mockRejectedValueOnce(failure);
    await expect(details.read("run")).rejects.toBe(failure);

    listEvents.mockClear();
    const resumed = await details.read("run");
    expect(resumed?.logs.map((log) => log.message)).toEqual(["original", "new page"]);
    expect(listEvents.mock.calls[0][0]).toMatchObject({ afterId: 3, runId: "run" });
  });

  it("rebuilds a failed initial read instead of retaining an incomplete new run", async () => {
    const store = memoryStore(recordedRun());
    const failure = new Error("second page failed");
    let fail = true;
    const listEvents = vi.fn(async (query: PipelineRunEventQuery = {}) => {
      if (fail && query.afterId === 1) throw failure;
      return (await store.listEvents(query)).slice(0, 1);
    });
    const details = new StudioRunDetails({ listEvents });
    await expect(details.read("run")).rejects.toBe(failure);
    fail = false;
    listEvents.mockClear();
    expect((await details.read("run"))?.logs.map((log) => log.message)).toEqual(["original"]);
    expect(listEvents.mock.calls[0][0]?.afterId).toBeUndefined();
  });
});
