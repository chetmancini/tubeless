import { describe, expect, it, vi } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import {
  createStudioApi,
  parseStudioCommands,
  parseStudioSnapshot,
} from "./run-store-ui-client-transport.js";

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "fixture",
    runId: "run-1",
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

function snapshot(runs: readonly StoredPipelineRun[] = [run()]) {
  return {
    activeRunCount: 0,
    completedRunCount: runs.length,
    definitions: [],
    failedRunCount: 0,
    generatedAtMs: 2,
    lastEventId: 1,
    liveRunIds: [],
    runs,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Studio API response parsing", () => {
  it("accepts a complete snapshot and rejects malformed nested run data", () => {
    expect(parseStudioSnapshot(snapshot())?.runs[0]?.runId).toBe("run-1");
    expect(
      parseStudioSnapshot(
        snapshot([
          run({
            steps: [
              {
                attempt: {
                  attemptId: "attempt-1",
                  retries: undefined as never,
                  startedAtMs: 1,
                  status: "completed",
                },
                id: "step",
                status: "completed",
              },
            ],
          }),
        ])
      )
    ).toBeUndefined();
  });

  it("validates command descriptors before returning them", () => {
    const valid = {
      commands: [
        {
          canPlan: true,
          id: "fixture",
          name: "Fixture",
          parameters: [
            {
              flag: "--name",
              key: "name",
              multiple: false,
              positional: false,
              required: true,
              type: "string",
            },
          ],
        },
      ],
    };
    expect(parseStudioCommands(valid)?.[0]?.id).toBe("fixture");
    expect(
      parseStudioCommands({
        commands: [{ ...valid.commands[0], parameters: [{ key: "name" }] }],
      })
    ).toBeUndefined();
  });

  it("rejects invalid successful payloads instead of exposing them to client state", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ runs: "not-an-array" })
    ) as unknown as typeof fetch;
    const api = createStudioApi(fetcher);
    await expect(api.loadSnapshot()).rejects.toThrow(/invalid response for snapshot/);
  });

  it("keeps launch requests same-origin guarded and returns only a validated run id", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ accepted: true, runId: "run-accepted" }, { status: 202 })
    ) as unknown as typeof fetch;
    const api = createStudioApi(fetcher);
    await expect(api.launch("fixture/id", { name: "Ada" })).resolves.toBe("run-accepted");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/commands/fixture%2Fid/runs",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          "x-tubeless-studio-launch": "1",
        },
        method: "POST",
      })
    );
  });
});
