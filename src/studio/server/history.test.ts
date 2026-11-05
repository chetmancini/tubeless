import { expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../../core/pipeline.js";
import type { PipelineRunStoreSnapshot, StoredPipelineRun } from "../../run-store/run-store.js";
import { StudioHistory } from "./history.js";

function run(runId: string, overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    runId,
    pipelineId: "work",
    status: "completed",
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    steps: [],
    startedAtMs: 1,
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

function snapshot(runs: StoredPipelineRun[]): PipelineRunStoreSnapshot {
  return {
    runs,
    activeRunCount: runs.filter((run) => run.status === "running").length,
    completedRunCount: runs.filter((run) => run.status === "completed").length,
    failedRunCount: runs.filter((run) => run.status === "failed").length,
    lastEventId: runs.reduce((count, run) => count + run.eventCount, 0),
    generatedAtMs: 1,
    definitions: [],
  };
}

it("reuses unrelated summaries and preserves earlier responses after one run gains an event", () => {
  const quiet = run("quiet");
  const active = run("active", { status: "running" });
  const source = snapshot([quiet, active]);
  const history = new StudioHistory(source);
  const before = history.workspace(0);
  const next = { ...active, eventCount: 2 };
  expect(history.update(snapshot([quiet, next]))).toBe(true);
  const after = history.workspace(1);
  expect(after.runs.find((run) => run.runId === "quiet")).toBe(
    before.runs.find((run) => run.runId === "quiet")
  );
  expect(after.runs.find((run) => run.runId === "active")?.eventCount).toBe(2);
  expect(before.runs.find((run) => run.runId === "active")?.eventCount).toBe(1);
  expect(after.eventCount).toBe(3);
  expect(history.update(source)).toBe(true);
  expect(history.workspace(2)).toMatchObject({ eventCount: 2 });
});

it("matches fresh history for filtered pages, nested activity, origins and definition pages", () => {
  let runs = [
    run("root"),
    run("child", { pipelineId: "child", parentRunId: "root", itemKey: "item" }),
    run("grandchild", { parentRunId: "child", status: "running" }),
    run("sibling", { parentRunId: "root", status: "running" }),
    ...Array.from({ length: 60 }, (_, index) => run(`quiet-${index}`)),
  ];
  const history = new StudioHistory(snapshot(runs));
  const updates: Partial<StoredPipelineRun>[] = [
    { eventCount: 2, correlationId: "search-me" },
    { status: "completed", eventCount: 3 },
    { status: "completed", eventCount: 2 },
    {
      eventCount: 2,
      steps: [
        {
          id: "fan-out",
          status: "running",
          nestedPipeline: { pipelineId: "child", mode: "for-each", stepCount: 0, stepIds: [] },
        },
      ],
    },
    { status: "running", eventCount: 3 },
  ];
  for (const [change, update] of updates.entries()) {
    const id = ["grandchild", "grandchild", "sibling", "root", "root"][change]!;
    runs = runs.map((run) => (run.runId === id ? { ...run, ...update } : run));
    const source = snapshot(runs);
    expect(history.update(source)).toBe(true);
    const fresh = new StudioHistory(source);
    for (const query of ["", "search-me", "quiet", "missing"]) {
      for (const offset of [0, 50, 100]) {
        for (const pipelineId of ["", "work", "child"]) {
          expect(history.workspace(change, query, offset, "grandchild", pipelineId)).toEqual(
            fresh.workspace(change, query, offset, "grandchild", pipelineId)
          );
        }
      }
    }
    for (const run of runs.slice(0, 4)) {
      expect(history.detail(run)).toEqual(fresh.detail(run));
      expect(history.childRuns(run.runId, 0)).toEqual(fresh.childRuns(run.runId, 0));
    }
    expect(history.definitionRuns("work", undefined, 50)).toEqual(
      fresh.definitionRuns("work", undefined, 50)
    );
  }
  expect(
    history.detail(runs[0]!).children.find((child) => child.runId === "child")?.origin
  ).toEqual({
    stepId: "fan-out",
    itemKey: "item",
  });
});

it("leaves the old history intact when membership, parent links or start times change", () => {
  const root = run("root");
  const child = run("child", { parentRunId: "missing" });
  const source = snapshot([root, child]);
  const history = new StudioHistory(source);
  const before = history.workspace(0);
  for (const runs of [
    [root, child, run("missing")],
    [
      { ...root, eventCount: 2 },
      { ...child, parentRunId: "root" },
    ],
    [
      { ...root, eventCount: 2 },
      { ...child, startedAtMs: 2 },
    ],
  ]) {
    expect(history.update(snapshot(runs))).toBe(false);
    expect(history.workspace(0)).toEqual(before);
  }
});
