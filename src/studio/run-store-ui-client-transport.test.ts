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
  it("validates artifact metadata and operation fields on recorded steps", () => {
    const entry = {
      operation: "read" as const,
      preview: false,
      attemptId: "attempt",
      timestampMs: 1,
      artifact: { id: "input" },
    };
    const read = (artifact: unknown) =>
      parseStudioSnapshot(
        snapshot([
          run({ steps: [{ id: "load", status: "completed", artifacts: [artifact as never] }] }),
        ])
      );
    expect(read(entry)).toBeDefined();
    expect(read({ ...entry, operation: "reuse" })).toBeDefined();
    for (const invalid of [
      { ...entry, preview: "false" },
      { ...entry, operation: "delete" },
      { ...entry, artifact: {} },
      { ...entry, artifact: { id: "input", metadata: { value: Infinity } } },
      { ...entry, artifact: { id: "input", metadata: { value: "a".repeat(17000) } } },
    ])
      expect(read(invalid)).toBeUndefined();
  });

  it("accepts a complete snapshot and rejects malformed nested run data", () => {
    expect(parseStudioSnapshot(snapshot())?.runs[0]?.runId).toBe("run-1");
    expect(parseStudioSnapshot(snapshot([run({ correlationId: 42 as never })]))).toBeUndefined();
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

  it("accepts iteration metadata and rejects invalid bounds or relationships", () => {
    const iteration = { runId: "parent", stepId: "repeat", attemptId: "attempt", index: 1 };
    const nestedPipeline = {
      mode: "iterate" as const,
      pipelineId: "child",
      maxIterations: 3,
      stepCount: 1,
      stepIds: ["work"],
    };
    const recorded = run({
      iteration,
      steps: [{ id: "repeat", status: "completed", nestedPipeline }],
    });
    expect(parseStudioSnapshot(snapshot([recorded]))?.runs[0]?.iteration).toEqual(iteration);
    expect(
      parseStudioSnapshot(snapshot([{ ...recorded, iteration: { ...iteration, index: 0 } }]))
    ).toBeUndefined();
    expect(
      parseStudioSnapshot(
        snapshot([
          run({
            steps: [
              {
                id: "repeat",
                status: "completed",
                nestedPipeline: { ...nestedPipeline, maxIterations: 0 },
              },
            ],
          }),
        ])
      )
    ).toBeUndefined();
  });

  it("rejects invalid successful payloads instead of exposing them to client state", async () => {
    const fetcher: typeof fetch = vi.fn(async () => jsonResponse({ runs: "not-an-array" }));
    const api = createStudioApi(fetcher);
    await expect(api.loadSnapshot()).rejects.toThrow(/invalid response for snapshot/);
  });

  it("validates projected run details without requiring raw events", async () => {
    const validFetcher: typeof fetch = vi.fn(async () => jsonResponse({ run: run() }));
    await expect(createStudioApi(validFetcher).loadRunDetail("run-1")).resolves.toEqual({
      run: run(),
    });

    const invalidFetcher: typeof fetch = vi.fn(async () =>
      jsonResponse({ run: { ...run(), logs: 1 } })
    );
    await expect(createStudioApi(invalidFetcher).loadRunDetail("run-1")).rejects.toThrow(
      /invalid response for run detail/
    );
  });

  it("keeps launch requests same-origin guarded and returns only a validated run id", async () => {
    const fetcher: typeof fetch = vi.fn(async () =>
      jsonResponse({ accepted: true, runId: "run-accepted" }, { status: 202 })
    );
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

it("accepts overridden steps and attempts in recorded Studio runs", () => {
  const recorded = snapshot([
    run({
      steps: [
        {
          id: "load",
          status: "completed",
          outputSource: "override",
          attempt: {
            attemptId: "override-1",
            startedAtMs: 1,
            finishedAtMs: 2,
            retries: [],
            status: "completed",
            outputSource: "override",
          },
        },
      ],
    }),
  ]);
  expect(parseStudioSnapshot(recorded)?.runs[0]?.steps[0]).toMatchObject({
    status: "completed",
    outputSource: "override",
  });
  recorded.runs[0]!.steps[0]!.outputSource = "invalid" as never;
  expect(parseStudioSnapshot(recorded)).toBeUndefined();
});
