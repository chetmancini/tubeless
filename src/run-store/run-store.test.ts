import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createSteps,
  definePipeline,
  RUN_MODEL_VERSION,
  type PipelineRunStatus,
  type PipelineStepLifecycleStatus,
} from "../core/pipeline.js";
import {
  createPipelineRunProjector,
  projectPipelineRunStore,
  type StoredPipelineAttempt,
  type StoredPipelineEvent,
  type StoredPipelineRun,
  type StoredPipelineRunStatus,
  type StoredPipelineStep,
} from "./run-store.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

function event(
  id: number,
  name: StoredPipelineEvent["name"],
  overrides: Record<string, unknown> = {}
): StoredPipelineEvent {
  const { payload: payloadOverrides, ...fields } = overrides;
  const payloads: Record<StoredPipelineEvent["name"], Record<string, unknown>> = {
    "pipeline.completed": {
      dryRun: false,
      errorCount: 0,
      finalized: false,
      status: "completed",
      stepCount: 0,
    },
    "pipeline.finalize.completed": {},
    "pipeline.finalize.failed": {},
    "pipeline.finalize.started": {},
    "pipeline.log": { level: "log", message: "" },
    "pipeline.started": { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    "step.attempted": { attempt: 1, attributes: {} },
    "step.cancelled": { status: "cancelled" },
    "step.complete": { status: "completed" },
    "step.failed": { status: "failed" },
    "step.planned": {
      dependencies: [],
      dryRun: "run",
      optionalDependencies: [],
      runtimeSkipPossible: false,
      selected: true,
      selectionReasons: [],
      skipAfterFailureOf: [],
    },
    "step.running": {},
    "step.skipped": { reason: "policy", status: "skipped" },
  };
  return {
    ...decodePipelineTraceEvent({
      name,
      payload: { ...payloads[name], ...(payloadOverrides as object | undefined) },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 100 + id,
      version: 2,
      ...fields,
    }),
    id,
  };
}

const historyFixture: StoredPipelineEvent[] = [
  event(1, "pipeline.started", {
    payload: { targetIds: ["publish"] },
  }),
  event(2, "step.planned", {
    payload: {
      description: "Load source rows.",
      name: "Load rows",
    },
    stepId: "load",
  }),
  event(3, "step.running", { attemptId: "attempt-1", stepId: "load" }),
  event(4, "step.attempted", {
    attemptId: "attempt-1",
    payload: { attempt: 2 },
    stepId: "load",
  }),
  event(5, "step.running", {
    attemptId: "attempt-1",
    payload: {
      progress: {
        completed: 4,
        detailCount: 1,
        details: [
          {
            id: "rows.csv",
            name: "Rows",
            depth: 2,
            completed: 4,
            total: 10,
            label: "read",
            status: "cancelled",
          },
        ],
        message: "loaded",
        total: 10,
      },
    },
    stepId: "load",
  }),
  event(6, "pipeline.log", {
    attemptId: "attempt-1",
    payload: { level: "log", message: "reading rows.csv" },
    stepId: "load",
  }),
  event(7, "step.failed", {
    attemptId: "attempt-1",
    durationMs: 4,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "source unavailable",
      phase: "execution",
    },
    stepId: "load",
  }),
  event(8, "pipeline.completed", {
    payload: { errorCount: 1, status: "failed" },
    durationMs: 7,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "source unavailable",
      phase: "execution",
    },
  }),
];

const definitionReplacementFixture: StoredPipelineEvent[] = [
  event(1, "pipeline.started", {
    payload: { targetIds: ["old-target"] },
    runId: "old-run",
  }),
  event(2, "step.planned", { runId: "old-run", stepId: "old-step" }),
  event(3, "pipeline.started", { runId: "new-run" }),
  event(4, "step.planned", { runId: "old-run", stepId: "late-old-step" }),
  event(5, "step.planned", { runId: "new-run", stepId: "new-step" }),
];

const failedBeforePlanningFixture: StoredPipelineEvent[] = [
  event(1, "pipeline.started", {
    payload: { targetIds: ["publish"] },
    runId: "valid-run",
  }),
  event(2, "step.planned", { runId: "valid-run", stepId: "publish" }),
  event(3, "pipeline.started", { runId: "invalid-run" }),
  event(4, "pipeline.completed", {
    payload: { errorCount: 1, status: "failed" },
    runId: "invalid-run",
  }),
];

function snapshotFromChunks(events: readonly StoredPipelineEvent[], generatedAtMs: number) {
  const projector = createPipelineRunProjector();
  const [first, second, third, ...rest] = events;
  if (first) projector.append([first]);
  if (second !== undefined || third !== undefined) {
    projector.append([second, third].filter((item) => item !== undefined));
  }
  if (rest.length > 0) projector.append(rest);
  return projector.snapshot(generatedAtMs);
}

describe("pipeline run store projections", () => {
  it("keeps executions distinct when external correlation is reused", async () => {
    const { step } = createSteps();
    const firstPipeline = definePipeline({
      id: "first-correlated",
      steps: [step("work", { run: () => "first" })],
      finalize: () => "first",
    });
    const { step: secondStep } = createSteps();
    const secondPipeline = definePipeline({
      id: "second-correlated",
      steps: [secondStep("work", { run: () => "second" })],
      finalize: () => "second",
    });
    const events: StoredPipelineEvent[] = [];
    const tracing = {
      exporter: {
        export(event: PipelineTraceEvent) {
          events.push(Object.assign({ id: events.length }, event));
        },
      },
    };

    const first = await firstPipeline.run({}, undefined, { correlationId: "job-42", tracing });
    const repeated = await firstPipeline.run({}, undefined, {
      correlationId: "job-42",
      tracing,
    });
    const other = await secondPipeline.run({}, undefined, { correlationId: "job-42", tracing });
    const snapshot = projectPipelineRunStore(events, 999);

    expect(new Set([first.runId, repeated.runId, other.runId]).size).toBe(3);
    expect(snapshot.runs).toHaveLength(3);
    expect(snapshot.runs.every((run) => run.correlationId === "job-42")).toBe(true);
    expect(snapshot.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pipelineId: "first-correlated", runCount: 2 }),
        expect.objectContaining({ pipelineId: "second-correlated", runCount: 1 }),
      ])
    );
  });

  it("reuses live status unions for stored run, step, and attempt records", () => {
    expectTypeOf<StoredPipelineRunStatus>().toEqualTypeOf<PipelineRunStatus | "running">();
    expectTypeOf<StoredPipelineStep["status"]>().toEqualTypeOf<PipelineStepLifecycleStatus>();
    expectTypeOf<StoredPipelineAttempt["status"]>().toEqualTypeOf<
      Exclude<PipelineStepLifecycleStatus, "planned">
    >();
    expectTypeOf<StoredPipelineRun["version"]>().toEqualTypeOf<typeof RUN_MODEL_VERSION>();
  });

  it("projects definitions, active history, attempts, progress, logs, and errors", () => {
    const events = historyFixture;

    const snapshot = projectPipelineRunStore(events, 999);

    expect(snapshot).toMatchObject({
      activeRunCount: 0,
      completedRunCount: 0,
      failedRunCount: 1,
      generatedAtMs: 999,
      lastEventId: 8,
    });
    expect(snapshot.definitions[0]).toMatchObject({
      pipelineId: "import",
      runCount: 1,
      targetIds: ["publish"],
      steps: [
        {
          description: "Load source rows.",
          id: "load",
          name: "Load rows",
        },
      ],
    });
    expect(snapshot.runs[0]).toMatchObject({
      durationMs: 7,
      logCount: 1,
      status: "failed",
      version: 2,
      steps: [
        {
          id: "load",
          progress: {
            completed: 4,
            detailCount: 1,
            details: [
              {
                id: "rows.csv",
                name: "Rows",
                depth: 2,
                completed: 4,
                total: 10,
                label: "read",
                status: "cancelled",
              },
            ],
            message: "loaded",
            total: 10,
          },
          status: "failed",
        },
      ],
    });
    expect(snapshot.runs[0]?.steps[0]?.attempt).toMatchObject({
      attemptId: "attempt-1",
      durationMs: 4,
      retries: [2],
      status: "failed",
    });
    expect(snapshot.runs[0]?.logs[0]).toMatchObject({
      attemptId: "attempt-1",
      message: "reading rows.csv",
      stepId: "load",
    });
  });

  it("projects nested pipeline metadata onto run steps and observed definitions", () => {
    const nested = {
      mode: "for-each" as const,
      pipelineId: "worker",
      stepCount: 1,
      stepIds: ["process"],
    };
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started"),
      event(2, "step.planned", {
        payload: {
          nestedPipeline: {
            mode: nested.mode,
            pipelineId: nested.pipelineId,
            stepCount: nested.stepCount,
            stepIds: nested.stepIds,
          },
        },
        stepId: "children",
      }),
      event(3, "step.running", { attemptId: "attempt-1", stepId: "children" }),
      event(4, "step.complete", { attemptId: "attempt-1", stepId: "children" }),
    ]);

    expect(snapshot.runs[0]?.steps[0]).toMatchObject({
      id: "children",
      nestedPipeline: nested,
      status: "completed",
    });
    expect(snapshot.definitions[0]?.steps[0]).toMatchObject({
      id: "children",
      nestedPipeline: nested,
    });
  });

  it("retains remote metadata from step.planned on runs and definitions", () => {
    const remote = { engine: "lambda", target: "enrich-v2" };
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started"),
      event(2, "step.planned", {
        payload: { remote },
        stepId: "enrich",
      }),
      event(3, "step.running", { attemptId: "attempt-1", stepId: "enrich" }),
      event(4, "step.complete", { attemptId: "attempt-1", stepId: "enrich" }),
    ]);

    expect(snapshot.runs[0]?.steps[0]).toMatchObject({ id: "enrich", remote, status: "completed" });
    expect(snapshot.definitions[0]?.steps[0]).toMatchObject({ id: "enrich", remote });
  });

  it("keeps original counts when details and nested step IDs are truncated", () => {
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started"),
      event(2, "step.planned", {
        payload: {
          nestedPipeline: {
            mode: "single",
            pipelineId: "wide-child",
            stepCount: 200,
            stepIds: Array.from({ length: 128 }, (_, index) => `step-${index}`),
          },
        },
        stepId: "child",
      }),
      event(3, "step.running", {
        attemptId: "attempt-1",
        payload: {
          progress: {
            completed: 128,
            detailCount: 200,
            details: Array.from({ length: 128 }, (_, index) => ({
              id: `item-${index}`,
              status: "completed",
            })),
            total: 200,
          },
        },
        stepId: "child",
      }),
    ]);

    expect(snapshot.runs[0]?.steps[0]?.nestedPipeline).toMatchObject({
      pipelineId: "wide-child",
      stepCount: 200,
    });
    expect(snapshot.runs[0]?.steps[0]?.nestedPipeline?.stepIds).toHaveLength(128);
    expect(snapshot.runs[0]?.steps[0]?.progress).toMatchObject({
      completed: 128,
      detailCount: 200,
    });
    expect(snapshot.runs[0]?.steps[0]?.progress?.details).toHaveLength(128);
  });

  it("keeps the last visible details when a later snapshot is empty", () => {
    const details = [{ id: "rows.csv", label: "read", status: "running" as const }];
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started"),
      event(2, "step.running", { attemptId: "attempt-1", stepId: "load" }),
      event(3, "step.running", {
        attemptId: "attempt-1",
        payload: {
          progress: {
            completed: 4,
            detailCount: 1,
            details,
            message: "loaded",
            total: 10,
          },
        },
        stepId: "load",
      }),
      event(4, "step.running", {
        attemptId: "attempt-1",
        payload: { progress: { completed: 0 } },
        stepId: "load",
      }),
      event(5, "step.complete", { attemptId: "attempt-1", stepId: "load" }),
    ]);

    expect(snapshot.runs[0]?.steps[0]?.progress).toEqual({
      completed: 4,
      detailCount: 1,
      details,
      message: "loaded",
      total: 10,
    });
  });

  it("stores repeated reportAttempt telemetry on one execution attempt", () => {
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started"),
      event(2, "step.running", { attemptId: "attempt-1", stepId: "load" }),
      event(3, "step.attempted", {
        attemptId: "attempt-1",
        payload: { attempt: 1 },
        stepId: "load",
      }),
      event(4, "step.attempted", {
        attemptId: "attempt-1",
        payload: { attempt: 2 },
        stepId: "load",
      }),
      event(5, "step.complete", { attemptId: "attempt-1", stepId: "load" }),
    ]);

    expect(snapshot.runs[0]?.steps[0]).toMatchObject({
      attempt: { attemptId: "attempt-1", retries: [1, 2] },
    });
    expect(snapshot.runs[0]?.steps[0]).not.toHaveProperty("attempts");
  });

  it("keeps a started run active until its terminal event arrives", () => {
    const snapshot = projectPipelineRunStore([event(1, "pipeline.started")], 200);

    expect(snapshot.activeRunCount).toBe(1);
    expect(snapshot.runs[0]?.status).toBe("running");
    expect(snapshot.runs[0]?.version).toBe(RUN_MODEL_VERSION);
  });

  it("replaces an observed definition when a newer run changes its schema", () => {
    const snapshot = projectPipelineRunStore(definitionReplacementFixture);

    expect(snapshot.definitions[0]).toMatchObject({
      runCount: 2,
      steps: [{ id: "new-step" }],
      targetIds: [],
    });
  });

  it("keeps the later-started definition when an earlier run is inserted with higher ids", () => {
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started", {
        runId: "later-short",
        timestampMs: 200,
      }),
      event(2, "step.planned", { runId: "later-short", stepId: "new-step", timestampMs: 201 }),
      event(3, "pipeline.started", {
        payload: { targetIds: ["old-target"] },
        runId: "earlier-long",
        timestampMs: 100,
      }),
      event(4, "step.planned", { runId: "earlier-long", stepId: "old-step", timestampMs: 250 }),
    ]);

    expect(snapshot.definitions[0]).toMatchObject({
      runCount: 2,
      steps: [{ id: "new-step" }],
      targetIds: [],
    });
  });

  it("retains the last planned definition when a newer run fails before planning", () => {
    const snapshot = projectPipelineRunStore(failedBeforePlanningFixture);

    expect(snapshot.definitions[0]).toMatchObject({
      runCount: 2,
      steps: [{ id: "publish" }],
      targetIds: ["publish"],
    });
  });
});

describe("incremental pipeline run projector", () => {
  it("matches one-shot projection when events are appended in chunks", () => {
    expect(snapshotFromChunks(historyFixture, 999)).toEqual(
      projectPipelineRunStore(historyFixture, 999)
    );
  });

  it("matches one-shot definition replacement when events are appended in chunks", () => {
    expect(snapshotFromChunks(definitionReplacementFixture, 400)).toEqual(
      projectPipelineRunStore(definitionReplacementFixture, 400)
    );
  });

  it("matches one-shot failed-before-planning when events are appended in chunks", () => {
    expect(snapshotFromChunks(failedBeforePlanningFixture, 400)).toEqual(
      projectPipelineRunStore(failedBeforePlanningFixture, 400)
    );
  });

  it("ignores duplicate and out-of-order event ids", () => {
    const projector = createPipelineRunProjector();
    projector.append([event(2, "pipeline.started", { runId: "run-2" })]);
    projector.append([
      event(1, "pipeline.started"),
      event(2, "pipeline.started", { runId: "run-2" }),
      event(3, "pipeline.completed", {
        runId: "run-2",
      }),
    ]);

    const expected = createPipelineRunProjector();
    expected.append([
      event(2, "pipeline.started", { runId: "run-2" }),
      event(3, "pipeline.completed", {
        runId: "run-2",
      }),
    ]);

    expect(projector.snapshot(50)).toEqual(expected.snapshot(50));
    expect(projector.snapshot(50)).toEqual(
      projectPipelineRunStore(
        [
          event(2, "pipeline.started", { runId: "run-2" }),
          event(3, "pipeline.completed", {
            runId: "run-2",
          }),
        ],
        50
      )
    );
  });

  it("accepts a first event whose store-local id is zero", () => {
    const started = event(0, "pipeline.started");
    const completed = event(1, "pipeline.completed");

    expect(projectPipelineRunStore([started], 200)).toMatchObject({
      lastEventId: 0,
      activeRunCount: 1,
      runs: [{ runId: "run-1", status: "running", startedAtMs: started.timestampMs }],
    });

    const projector = createPipelineRunProjector();
    projector.append([started]);
    projector.append([started, completed]);
    expect(projector.snapshot(200)).toEqual(projectPipelineRunStore([started, completed], 200));
  });

  it("keeps the same snapshot when a later batch repeats already accepted events", () => {
    const projector = createPipelineRunProjector();
    projector.append(historyFixture);
    projector.append([...historyFixture].reverse());

    expect(projector.snapshot(999)).toEqual(projectPipelineRunStore(historyFixture, 999));
  });

  it("does not re-fold historical events on a no-new-events snapshot", () => {
    const events: StoredPipelineEvent[] = [];
    let id = 1;
    for (let index = 0; index < 4_000; index += 1) {
      const pipelineId = index % 3 === 0 ? "alpha" : "beta";
      const runId = `run-${index}`;
      events.push(
        event(id, "pipeline.started", {
          payload: { targetIds: index % 5 === 0 ? ["work"] : [] },
          pipelineId,
          runId,
          timestampMs: index * 10,
        })
      );
      id += 1;
      if (index % 4 === 0) {
        events.push(event(id, "step.planned", { pipelineId, runId, stepId: "work" }));
        id += 1;
      }
      events.push(
        event(id, "pipeline.completed", {
          payload: {
            errorCount: index % 7 === 0 ? 1 : 0,
            status: index % 7 === 0 ? "failed" : "completed",
          },
          pipelineId,
          runId,
          timestampMs: index * 10 + 5,
        })
      );
      id += 1;
    }

    const projector = createPipelineRunProjector();
    projector.append(events);
    const first = projector.snapshot(1);
    expect(first.lastEventId).toBe(events.at(-1)?.id);
    expect(first.runs).toHaveLength(4_000);
    expect(first).toEqual(projectPipelineRunStore(events, 1));

    projector.append([]);
    projector.append(events.slice(0, 8));
    const second = projector.snapshot(1);
    expect(second).toBe(first);

    const omittedNow = projector.snapshot();
    expect(omittedNow).toBe(first);

    const refreshed = projector.snapshot(2);
    expect(refreshed).not.toBe(first);
    expect(refreshed.generatedAtMs).toBe(2);
    expect(refreshed.runs).toBe(first.runs);
    expect(refreshed.definitions).toBe(first.definitions);
    expect(refreshed.lastEventId).toBe(first.lastEventId);
  });

  it("owns retained run metadata and errors independently of producers and snapshots", () => {
    const started = event(0, "pipeline.started", { correlationId: "original" });
    const completed = event(1, "pipeline.completed", {
      payload: { status: "failed", errorCount: 1 },
      error: {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        phase: "execution",
        message: "original failure",
        cause: { message: "original cause" },
      },
    });
    const projector = createPipelineRunProjector();
    projector.append([started, completed]);
    started.timestampMs = 900;
    started.correlationId = "changed";
    if (started.name === "pipeline.started") started.payload.dryRun = true;
    completed.error!.message = "producer changed";
    completed.error!.cause!.message = "producer changed cause";

    const first = projector.snapshot(10).runs[0]!;
    expect(first).toMatchObject({
      correlationId: "original",
      dryRun: false,
      startedAtMs: 100,
      error: { message: "original failure", cause: { message: "original cause" } },
    });
    first.error!.cause!.message = "consumer changed cause";
    // A new snapshot must be derived from private projection state, not the old output.
    projector.append([event(2, "pipeline.log", { payload: { message: "late log" } })]);
    const next = projector.snapshot(20).runs[0]!;
    expect(next.error).toMatchObject({
      message: "original failure",
      cause: { message: "original cause" },
    });
    expect(next.logCount).toBe(1);
  });

  it("counts logs without retaining bodies when retainLogs is false", () => {
    const projector = createPipelineRunProjector({ retainLogs: false });
    projector.append([
      event(1, "pipeline.started"),
      event(2, "pipeline.log", {
        payload: { level: "log", message: "secret payload" },
        stepId: "load",
      }),
      event(3, "pipeline.completed"),
    ]);

    const snapshot = projector.snapshot(1);
    expect(snapshot.runs[0]).toMatchObject({
      eventCount: 3,
      logCount: 1,
      logs: [],
      status: "completed",
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret payload");
  });
});
