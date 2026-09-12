import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import { createStudioRunIndex } from "./run-store-ui-client.js";
import type { StoredPipelineRun, StoredPipelineRunStatus } from "../run-store/run-store.js";

function run(
  overrides: Partial<StoredPipelineRun> & Pick<StoredPipelineRun, "runId">
): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: overrides.pipelineId ?? overrides.runId,
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

function cloneRuns(runs: readonly StoredPipelineRun[]) {
  return structuredClone(runs);
}

function instrumentedRuns(count: number, kind: "flat" | "chain") {
  let parentReads = 0;
  const runs: StoredPipelineRun[] = [];
  for (let index = 0; index < count; index += 1) {
    const parentRunId = kind === "chain" && index > 0 ? `run-${index - 1}` : undefined;
    const record: StoredPipelineRun = run({
      pipelineId: `pipe-${index}`,
      runId: `run-${index}`,
      startedAtMs: 1_000 + index,
    });
    Object.defineProperty(record, "parentRunId", {
      configurable: true,
      enumerable: true,
      get() {
        parentReads += 1;
        return parentRunId;
      },
    });
    runs.push(record);
  }
  return {
    parentReads() {
      return parentReads;
    },
    runs,
  };
}

function renderLike(index: ReturnType<typeof createStudioRunIndex>, query = "") {
  const matched = query ? index.matchingRootIds(query) : null;
  const roots = index.roots
    .filter((item) => !matched || matched.has(item.runId))
    .sort(
      (left, right) =>
        Number(index.subtreeIsRunning(right.runId)) - Number(index.subtreeIsRunning(left.runId)) ||
        right.startedAtMs - left.startedAtMs
    );
  const active: StoredPipelineRun[] = [];
  const historical: StoredPipelineRun[] = [];
  for (const root of roots) {
    index.descendantCount(root.runId);
    if (index.subtreeIsRunning(root.runId)) active.push(root);
    else historical.push(root);
  }
  return { active, historical, roots };
}

describe("createStudioRunIndex", () => {
  it("returns empty lookups for empty history", () => {
    const index = createStudioRunIndex([]);
    expect(index.roots).toEqual([]);
    expect(index.runById("missing")).toBeUndefined();
    expect(index.childrenOf("missing")).toEqual([]);
    expect(index.descendantsOf("missing")).toEqual([]);
    expect(index.ancestorsOf("missing")).toEqual([]);
    expect(index.descendantCount("missing")).toBe(0);
    expect(index.subtreeIsRunning("missing")).toBe(false);
    expect(index.matchingRootIds("any")).toEqual(new Set());
  });

  it("treats flat runs as roots in snapshot order", () => {
    const older = run({ runId: "a", startedAtMs: 10 });
    const newer = run({ runId: "b", startedAtMs: 20 });
    const index = createStudioRunIndex([older, newer]);
    expect(index.roots).toEqual([older, newer]);
    expect(index.childrenOf("a")).toEqual([]);
    expect(index.descendantCount("a")).toBe(0);
    expect(renderLike(index).roots.map((item) => item.runId)).toEqual(["b", "a"]);
  });

  it("sorts siblings by start time and keeps snapshot order on ties", () => {
    const root = run({ runId: "root", startedAtMs: 1 });
    const first = run({ parentRunId: "root", runId: "first", startedAtMs: 5 });
    const tiedEarly = run({ parentRunId: "root", runId: "tied-early", startedAtMs: 8 });
    const tiedLate = run({ parentRunId: "root", runId: "tied-late", startedAtMs: 8 });
    const newest = run({ parentRunId: "root", runId: "newest", startedAtMs: 9 });
    const index = createStudioRunIndex([root, first, tiedEarly, tiedLate, newest]);
    expect(index.childrenOf("root").map((item) => item.runId)).toEqual([
      "newest",
      "tied-early",
      "tied-late",
      "first",
    ]);
    expect(index.descendantCount("root")).toBe(4);
  });

  it("marks a completed root active when a grandchild is running", () => {
    const root = run({ pipelineId: "parent", runId: "root", startedAtMs: 1, status: "completed" });
    const child = run({
      parentRunId: "root",
      pipelineId: "child",
      runId: "child",
      startedAtMs: 2,
      status: "completed",
    });
    const grandchild = run({
      parentRunId: "child",
      pipelineId: "grand",
      runId: "grand",
      startedAtMs: 3,
      status: "running",
    });
    const idle = run({ pipelineId: "idle", runId: "idle", startedAtMs: 4, status: "completed" });
    const index = createStudioRunIndex([root, child, grandchild, idle]);
    expect(index.roots.map((item) => item.runId)).toEqual(["root", "idle"]);
    expect(index.descendantsOf("root").map((item) => item.runId)).toEqual(["child", "grand"]);
    expect(index.descendantCount("root")).toBe(2);
    expect(index.descendantCount("child")).toBe(1);
    expect(index.subtreeIsRunning("root")).toBe(true);
    expect(index.subtreeIsRunning("idle")).toBe(false);
    const rendered = renderLike(index);
    expect(rendered.active.map((item) => item.runId)).toEqual(["root"]);
    expect(rendered.historical.map((item) => item.runId)).toEqual(["idle"]);
  });

  it("treats missing parents as roots and keeps the orphan under that parent id", () => {
    const orphan = run({
      parentRunId: "gone",
      pipelineId: "orphan",
      runId: "orphan",
      startedAtMs: 2,
    });
    const root = run({ pipelineId: "root", runId: "root", startedAtMs: 1 });
    const index = createStudioRunIndex([orphan, root]);
    expect(index.roots.map((item) => item.runId)).toEqual(["orphan", "root"]);
    expect(index.childrenOf("gone")).toEqual([orphan]);
    expect(index.ancestorsOf("orphan")).toEqual([]);
    expect(index.rootRunId("orphan")).toBe("orphan");
  });

  it("matches a root when only a descendant satisfies search", () => {
    const root = run({ pipelineId: "alpha", runId: "root-1", startedAtMs: 1 });
    const child = run({
      parentRunId: "root-1",
      pipelineId: "beta-search",
      runId: "child-1",
      startedAtMs: 2,
    });
    const other = run({ pipelineId: "gamma", runId: "root-2", startedAtMs: 3 });
    const index = createStudioRunIndex([root, child, other]);
    expect(index.matchingRootIds("beta")).toEqual(new Set(["root-1"]));
    expect(index.matchingRootIds("ROOT-1")).toEqual(new Set(["root-1"]));
    expect(index.matchingRootIds("missing")).toEqual(new Set());
    expect(renderLike(index, "beta").roots.map((item) => item.runId)).toEqual(["root-1"]);
  });

  it("walks ancestors from nearest missing parent stop", () => {
    const root = run({ pipelineId: "root", runId: "root", startedAtMs: 1 });
    const child = run({ parentRunId: "root", pipelineId: "child", runId: "child", startedAtMs: 2 });
    const grand = run({
      parentRunId: "child",
      pipelineId: "grand",
      runId: "grand",
      startedAtMs: 3,
    });
    const index = createStudioRunIndex([root, child, grand]);
    expect(index.ancestorsOf("grand").map((item) => item.runId)).toEqual(["root", "child"]);
    expect(index.rootRunId("grand")).toBe("root");
    expect(index.rootRunId(null)).toBeNull();
  });

  it("hides pure cycles from roots and still terminates lookups", () => {
    const left = run({ parentRunId: "right", pipelineId: "left", runId: "left", startedAtMs: 1 });
    const right = run({ parentRunId: "left", pipelineId: "right", runId: "right", startedAtMs: 2 });
    const visible = run({ pipelineId: "visible", runId: "visible", startedAtMs: 3 });
    const index = createStudioRunIndex([left, right, visible]);
    expect(index.roots.map((item) => item.runId)).toEqual(["visible"]);
    expect(index.descendantsOf("left").map((item) => item.runId)).toEqual(["right"]);
    expect(index.descendantsOf("right").map((item) => item.runId)).toEqual(["left"]);
    expect(index.descendantCount("left")).toBe(1);
    expect(index.ancestorsOf("left").map((item) => item.runId)).toEqual(["left", "right"]);
    expect(index.rootRunId("left")).toBe("left");
    expect(index.matchingRootIds("left")).toEqual(new Set());
  });

  it("hides a self-parent from roots and reports no descendants", () => {
    const loop = run({ parentRunId: "loop", pipelineId: "loop", runId: "loop", startedAtMs: 1 });
    const index = createStudioRunIndex([loop]);
    expect(index.roots).toEqual([]);
    expect(index.descendantsOf("loop")).toEqual([]);
    expect(index.descendantCount("loop")).toBe(0);
    expect(index.ancestorsOf("loop")).toEqual([loop]);
    expect(index.rootRunId("loop")).toBe("loop");
  });

  it("does not mutate snapshot records or cache descendant arrays", () => {
    const runs = [
      run({ runId: "root", startedAtMs: 1 }),
      run({ parentRunId: "root", runId: "child", startedAtMs: 2 }),
    ];
    const before = cloneRuns(runs);
    const index = createStudioRunIndex(runs);
    const first = index.descendantsOf("root");
    const second = index.descendantsOf("root");
    first.pop();
    expect(index.descendantsOf("root").map((item) => item.runId)).toEqual(["child"]);
    expect(second.map((item) => item.runId)).toEqual(["child"]);
    expect(runs).toEqual(before);
    expect(runs[0]).toBe(index.runById("root"));
  });

  it("computes a deep parent chain without overflowing", () => {
    const runs: StoredPipelineRun[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      runs.push(
        run({
          parentRunId: index === 0 ? undefined : `node-${index - 1}`,
          runId: `node-${index}`,
          startedAtMs: index,
        })
      );
    }
    const index = createStudioRunIndex(runs);
    expect(index.roots.map((item) => item.runId)).toEqual(["node-0"]);
    expect(index.descendantCount("node-0")).toBe(1_999);
    expect(index.descendantsOf("node-0")).toHaveLength(1_999);
    expect(index.ancestorsOf("node-1999").map((item) => item.runId)[0]).toBe("node-0");
  });

  it("reads each parentRunId once on 1k/2k/4k flat histories and parent chains", () => {
    for (const kind of ["flat", "chain"] as const) {
      const reads = [1_000, 2_000, 4_000].map((count) => {
        const fixture = instrumentedRuns(count, kind);
        const index = createStudioRunIndex(fixture.runs);
        const afterBuild = fixture.parentReads();
        renderLike(index);
        renderLike(index, "pipe-");
        renderLike(index, "run-0");
        index.matchingRootIds("pipe-");
        index.rootRunId(`run-${count - 1}`);
        index.ancestorsOf(`run-${count - 1}`);
        expect(fixture.parentReads(), `${kind} ${count} extra reads after build`).toBe(afterBuild);
        return afterBuild;
      });
      expect(reads, kind).toEqual([1_000, 2_000, 4_000]);
    }
  });

  it("sorts with precomputed activity instead of descendant walks", () => {
    const running: StoredPipelineRunStatus = "running";
    const completed: StoredPipelineRunStatus = "completed";
    const olderActive = run({ runId: "older-active", startedAtMs: 1, status: running });
    const newerIdle = run({ runId: "newer-idle", startedAtMs: 5, status: completed });
    const index = createStudioRunIndex([olderActive, newerIdle]);
    expect(renderLike(index).roots.map((item) => item.runId)).toEqual([
      "older-active",
      "newer-idle",
    ]);
  });
});
