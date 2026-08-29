import { describe, expect, it, vi } from "vitest";
import {
  createSteps,
  defaultPipelineContext,
  definePipeline,
  type PipelineLogger,
} from "./pipeline.js";
import type { PipelineTraceEvent } from "./tracing.js";

function createLogger(): PipelineLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    error: () => undefined,
    log: () => undefined,
    warn: (message) => warnings.push(String(message)),
    warnings,
  };
}

describe("pipeline tracing", () => {
  it("exports ordered lifecycle events with correlation, attempt, duration, and error data", async () => {
    const step = createSteps();
    const succeed = step("succeed", {
      run: (_inputs, context) => {
        context.reportAttempt(2, { provider: "test" });
        context.reportProgress({
          completed: 1,
          details: [{ id: "source", label: "prepared", status: "running" }],
          message: "prepared",
          total: 2,
        });
        context.log.log("normalized", 12);
        return "ok";
      },
    });
    const fail = step("fail", {
      dependsOn: [succeed],
      run: () => {
        const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
        const error = new Error("network unavailable", { cause }) as Error & { code: string };
        error.code = "NETWORK";
        throw error;
      },
    });
    const skipped = step("skipped", { dependsOn: [fail], run: () => "never" });
    const pipeline = definePipeline({
      id: "traced",
      steps: [succeed, fail, skipped],
      finalize: () => "never",
    });
    const events: PipelineTraceEvent[] = [];
    const flush = vi.fn();
    let timestamp = 100;

    const result = await pipeline.run(
      {},
      {
        ...defaultPipelineContext(),
        log: createLogger(),
        now: () => timestamp++,
        parentRunId: "parent-1",
        runId: "run-1",
        tracing: {
          exporter: { export: (event) => events.push(event), flush },
          itemKey: "chapter-3",
        },
      }
    );

    expect(result.status).not.toBe("completed");
    expect(result.runId).toBe("run-1");
    expect(result.parentRunId).toBe("parent-1");
    expect(events.map((event) => event.name)).toEqual([
      "pipeline.started",
      "step.planned",
      "step.planned",
      "step.planned",
      "step.running",
      "step.attempted",
      "step.running",
      "pipeline.log",
      "step.complete",
      "step.running",
      "step.failed",
      "step.skipped",
      "pipeline.completed",
    ]);
    expect(events.every((event) => event.runId === "run-1")).toBe(true);
    expect(events.every((event) => event.parentRunId === "parent-1")).toBe(true);
    expect(events.every((event) => event.itemKey === "chapter-3")).toBe(true);
    expect(events.find((event) => event.name === "step.attempted")).toMatchObject({
      attributes: { attempt: 2, provider: "test" },
      attemptId: result.steps.find(({ id }) => id === "succeed")?.attemptId,
      stepId: "succeed",
    });
    const runningEvents = events.filter((event) => event.name === "step.running");
    expect(runningEvents[0]?.attributes).not.toHaveProperty("detail_count");
    expect(runningEvents[0]?.attributes).not.toHaveProperty("details");
    expect(runningEvents.find((event) => event.attributes.completed === 1)?.attributes).toEqual({
      completed: 1,
      detail_count: 1,
      details: JSON.stringify([{ id: "source", label: "prepared", status: "running" }]),
      message: "prepared",
      total: 2,
    });
    expect(events.find((event) => event.name === "pipeline.log")).toMatchObject({
      attributes: { level: "log", message: "normalized 12" },
      attemptId: result.steps.find(({ id }) => id === "succeed")?.attemptId,
      stepId: "succeed",
    });
    expect(events.find((event) => event.name === "step.planned")).toMatchObject({
      attributes: {
        dependencies: "[]",
        dry_run: "run",
        optional_dependencies: "[]",
        runtime_skip_possible: false,
      },
      stepId: "succeed",
    });
    expect(events.find((event) => event.name === "step.failed")).toMatchObject({
      attemptId: result.steps.find(({ id }) => id === "fail")?.attemptId,
      error: {
        cause: {
          message: "socket closed",
          name: "Error",
          sourceCode: "ECONNRESET",
        },
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "network unavailable",
        phase: "execution",
        sourceCode: "NETWORK",
      },
      stepId: "fail",
    });
    expect(events.find((event) => event.name === "step.skipped")).toMatchObject({
      attributes: {
        dependency_id: "fail",
        reason: "fail-fast",
        status: "skipped",
      },
      stepId: "skipped",
    });
    expect(events.find((event) => event.name === "pipeline.completed")?.durationMs).toBeGreaterThan(
      0
    );
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("isolates exporter failures and still completes the pipeline", async () => {
    const step = createSteps();
    const pipeline = definePipeline({
      id: "trace-isolation",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const log = createLogger();

    const result = await pipeline.run(
      {},
      {
        ...defaultPipelineContext(),
        log,
        runId: "isolated",
        tracing: {
          exporter: {
            export: () => Promise.reject(new Error("collector unavailable")),
            flush: () => Promise.reject(new Error("flush unavailable")),
          },
        },
      }
    );

    expect(result.status).toBe("completed");
    expect(log.warnings).toContain("Pipeline trace exporter failed: collector unavailable");
    expect(log.warnings).toContain("Pipeline trace exporter flush failed: flush unavailable");
  });

  it("links child runs to the parent trace identity", async () => {
    const childStep = createSteps();
    const child = definePipeline({
      id: "trace-child",
      steps: [childStep("inside", { run: () => "child" })],
      finalize: (outputs) => outputs.inside,
    });
    const parentStep = createSteps();
    const childStage = parentStep.fromPipeline("child-stage", {
      mapOptions: () => ({}),
      pipeline: child,
    });
    const parent = definePipeline({
      id: "trace-parent",
      steps: [childStage],
      finalize: (outputs) => outputs["child-stage"],
    });
    const events: PipelineTraceEvent[] = [];

    await expect(
      parent.run(
        {},
        {
          ...defaultPipelineContext(),
          runId: "parent-run",
          tracing: {
            exporter: { export: (event) => events.push(event) },
          },
        }
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(
      events.find(
        (event) => event.name === "pipeline.started" && event.pipelineId === "trace-child"
      )
    ).toMatchObject({ parentRunId: "parent-run" });
    expect(
      events.find((event) => event.name === "step.planned" && event.pipelineId === "trace-parent")
    ).toMatchObject({
      attributes: {
        nested_pipeline: JSON.stringify({
          mode: "single",
          pipelineId: "trace-child",
          stepIds: ["inside"],
        }),
      },
      stepId: "child-stage",
    });
  });

  it("adds stable mapped item keys to descendant runs", async () => {
    interface ChildOptions {
      value: string;
    }
    interface ParentOptions {
      values: readonly string[];
    }

    const childStep = createSteps<ChildOptions>();
    const child = definePipeline({
      id: "trace-mapped-child",
      steps: [childStep("inside", { run: (_inputs, context) => context.options.value })],
      finalize: (outputs) => outputs.inside ?? "",
    });
    const parentStep = createSteps<ParentOptions>();
    const children = parentStep.forEachPipeline("children", {
      items: (_inputs, context) => context.options.values,
      key: (value) => value,
      mapOptions: (value) => ({ value }),
      pipeline: child,
    });
    const parent = definePipeline({
      id: "trace-mapped-parent",
      steps: [children],
      finalize: (outputs) => outputs.children ?? [],
    });
    const events: PipelineTraceEvent[] = [];

    await expect(
      parent.run(
        { values: ["first", "second"] },
        {
          ...defaultPipelineContext(),
          runId: "mapped-parent-run",
          tracing: {
            exporter: { export: (event) => events.push(event) },
          },
        }
      )
    ).resolves.toMatchObject({ status: "completed" });

    const childStarts = events.filter(
      (event) => event.name === "pipeline.started" && event.pipelineId === "trace-mapped-child"
    );
    expect(childStarts).toHaveLength(2);
    expect(childStarts.map((event) => event.itemKey).sort()).toEqual(["first", "second"]);
    expect(childStarts.every((event) => event.parentRunId === "mapped-parent-run")).toBe(true);
  });

  it("bounds progress details and records the original detail count", async () => {
    const step = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({
          completed: 1,
          details: Array.from({ length: 130 }, (_, index) => ({
            id: index === 0 ? "x".repeat(5_000) : `item-${index}`,
            label: index === 0 ? "y".repeat(5_000) : "scan",
            status: "running",
          })),
          message: "items",
          total: 130,
        });
        return "ok";
      },
    });
    const pipeline = definePipeline({
      id: "traced-details",
      steps: [work],
      finalize: () => "ok",
    });
    const events: PipelineTraceEvent[] = [];

    await pipeline.run(
      {},
      {
        ...defaultPipelineContext(),
        log: createLogger(),
        tracing: { exporter: { export: (event) => events.push(event) } },
      }
    );

    const progress = events.find(
      (event) => event.name === "step.running" && event.attributes.completed === 1
    );
    expect(progress?.attributes.detail_count).toBe(130);
    const details = JSON.parse(String(progress?.attributes.details)) as Array<{
      id: string;
      label?: string;
    }>;
    expect(details).toHaveLength(128);
    expect(details[0]?.id).toHaveLength(4_096);
    expect(details[0]?.label).toHaveLength(4_096);
  });

  it("omits detail attributes when progress has no detail rows", async () => {
    const step = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 1, message: "batches", total: 2 });
        return "ok";
      },
    });
    const pipeline = definePipeline({
      id: "traced-plain-progress",
      steps: [work],
      finalize: () => "ok",
    });
    const events: PipelineTraceEvent[] = [];

    await pipeline.run(
      {},
      {
        ...defaultPipelineContext(),
        log: createLogger(),
        tracing: { exporter: { export: (event) => events.push(event) } },
      }
    );

    expect(
      events.find((event) => event.name === "step.running" && event.attributes.completed === 1)
        ?.attributes
    ).toEqual({ completed: 1, message: "batches", total: 2 });
  });
});
