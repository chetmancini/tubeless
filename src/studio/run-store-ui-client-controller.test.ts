import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import { loadSelectedRunDetail } from "./run-store-ui-client-controller.js";
import { createStudioRunIndex, createStudioState } from "./run-store-ui-client-model.js";

function run(eventCount: number): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount,
    logCount: 0,
    logs: [],
    pipelineId: "pipeline-1",
    runId: "run-1",
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
  };
}

describe("loadSelectedRunDetail", () => {
  it("retains the last successful detail when its refresh fails", async () => {
    const previousRun = run(1);
    const state = createStudioState();
    state.selectedRunId = previousRun.runId;
    state.detail = { run: previousRun };
    state.detailFingerprint = "run-1:1:completed";
    state.runIndex = createStudioRunIndex([run(2)]);

    await expect(
      loadSelectedRunDetail(state, () => Promise.reject(new Error("detail unavailable")))
    ).resolves.toBeUndefined();

    expect(state.detail).toEqual({ run: previousRun });
    expect(state.detailFingerprint).toBe("run-1:1:completed");
  });
});
