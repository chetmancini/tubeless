import { describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createSteps, definePipeline } from "./pipeline.js";
import type { PipelinePlan, PipelineRun, PipelineStepProgress } from "./pipeline-types.js";
import { makePipeline } from "./pipeline.test-support.js";

describe("lifecycle observation isolation", () => {
  it("isolates plans and step metadata from every hook and the executor", async () => {
    const events: PipelineTraceEvent[] = [];
    const planned: string[] = [];
    const started: string[] = [];
    let retainedPlan: PipelinePlan | undefined;
    const result = await makePipeline("isolated-plan").run(
      {},
      {},
      {
        hooks: [
          {
            onPipelineStart(plan) {
              retainedPlan = plan;
              plan.steps.length = 0;
              plan.ok = false;
            },
            onStepStatus(event) {
              event.step.id = "changed";
              event.step.dependencies.length = 0;
              event.step.selected = false;
              event.status = "planned";
            },
            onStepStart(event) {
              event.step.id = "also-changed";
            },
          },
          {
            onPipelineStart: (plan) => planned.push(...plan.steps.map((step) => step.id)),
            onStepStart: ({ step }) => started.push(step.id),
          },
        ],
        tracing: { exporter: { export: (event) => void events.push(event) } },
      }
    );

    expect(planned).toEqual(["build", "write"]);
    expect(started).toEqual(["build", "write"]);
    expect(result).toMatchObject({ status: "completed", value: ["build", "build+write"] });
    expect(result.steps.map(({ id }) => id)).toEqual(["build", "write"]);
    expect(
      events.filter((event) => event.name === "step.running").map((event) => event.stepId)
    ).toEqual(["build", "write"]);
    expect(events.find((event) => event.name === "pipeline.started")?.payload).toMatchObject({
      stepCount: 2,
    });
    expect(retainedPlan?.steps).toEqual([]);
  });

  it("detaches progress details from producers, other hooks, and retained observations", async () => {
    const progress: PipelineStepProgress = {
      completed: 1,
      details: [{ id: "item", label: "original" }],
    };
    const observed: PipelineStepProgress[] = [];
    const { step } = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress(progress);
        progress.completed = 2;
        progress.details![0]!.label = "producer changed";
      },
    });
    await definePipeline({ id: "progress", steps: [work] }).run(
      {},
      {},
      {
        hooks: [
          {
            onStepStatus(event) {
              if (event.status === "running" && event.progress) {
                event.progress.completed = 99;
                event.progress.details![0]!.label = "generic hook changed";
              }
            },
            onStepProgress({ progress }) {
              progress.details![0]!.label = "focused hook changed";
            },
          },
          { onStepProgress: ({ progress }) => observed.push(progress) },
        ],
      }
    );
    expect(observed).toEqual([{ completed: 1, details: [{ id: "item", label: "original" }] }]);
    expect(progress.details![0]!.label).toBe("producer changed");
  });

  it.each(["step", "finalization"] as const)(
    "protects %s errors and final reports",
    async (phase) => {
      const events: PipelineTraceEvent[] = [];
      const messages: string[] = [];
      const result = await makePipeline("errors").run(
        phase === "step" ? { failStep: "build" } : { failFinalize: true },
        {},
        {
          hooks: [
            {
              onStepFail({ error }) {
                error.message = "changed";
                if (error.cause) error.cause.message = "changed cause";
              },
              onFinalizeError({ error }) {
                error.message = "changed";
              },
              onPipelineComplete(run) {
                run.status = "completed";
                run.errors.length = 0;
                run.steps.length = 0;
              },
            },
            {
              onPipelineComplete: (run) =>
                messages.push(...run.errors.map((error) => error.message)),
            },
          ],
          tracing: { exporter: { export: (event) => void events.push(event) } },
        }
      );
      expect(result.status).toBe("failed");
      expect(result.steps).toHaveLength(2);
      expect(messages).toEqual(result.errors.map((error) => error.message));
      expect(messages.join(" ")).not.toContain("changed");
      expect(events.find((event) => event.name === "pipeline.completed")?.payload).toMatchObject({
        status: "failed",
      });
      expect(
        events
          .filter((event) => event.error)
          .map((event) => event.error?.message)
          .join(" ")
      ).not.toContain("changed");
    }
  );

  it("preserves opaque result identity while isolating result envelopes", async () => {
    const value = { action: () => "domain function", map: new Map([["key", 1]]) };
    const warn = vi.fn();
    const observed: unknown[] = [];
    let retained: PipelineRun<unknown> | undefined;
    const result = await makePipeline("opaque", value, true).run(
      {},
      {},
      {
        hooks: [
          {
            onFinalizeComplete(event) {
              event.value = "replaced";
            },
            onPipelineComplete(run) {
              retained = run;
              run.value = "replaced";
              run.status = "failed";
              run.steps[0]!.id = "changed";
            },
          },
          {
            onFinalizeComplete: (event) => observed.push(event.value),
            onPipelineComplete: (run) => observed.push(run.value),
          },
        ],
        log: { log: vi.fn(), error: vi.fn(), warn },
      }
    );
    expect(result.value).toBe(value);
    expect(observed).toEqual([value, value]);
    expect(result.status).toBe("completed");
    expect(result.steps[0]!.id).toBe("build");
    expect(retained).not.toBe(result);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cannot turn rejected selections into successful runs", async () => {
    const result = await makePipeline("rejected").run(
      {},
      { targets: [] },
      {
        hooks: {
          onPipelineStart(plan) {
            plan.ok = true;
            plan.errors.length = 0;
          },
          onPipelineComplete(run) {
            run.status = "completed";
            run.errors.length = 0;
          },
        },
      }
    );
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.code).toBe("TUBELESS_PLANNING_TARGET_SELECTION_EMPTY");
  });

  it.each(["skipped", "cancelled"] as const)(
    "protects %s observations and reports",
    async (status) => {
      const { step } = createSteps();
      const work = step("work", { dryRun: "skip", run: () => "done" });
      const observations: string[] = [];
      const result = await definePipeline({ id: "terminal", steps: [work] }).run(
        {},
        { dryRun: status === "skipped" },
        {
          signal: status === "cancelled" ? AbortSignal.abort("stop") : undefined,
          hooks: [
            {
              onStepSkip(event) {
                event.reason = "policy";
                event.step.id = "changed";
              },
              onStepCancel(event) {
                event.error.message = "changed";
                event.step.id = "changed";
              },
            },
            {
              onStepSkip: (event) => observations.push(event.step.id, event.reason),
              onStepCancel: (event) => observations.push(event.step.id, event.error.message),
            },
          ],
        }
      );
      expect(observations[0]).toBe("work");
      expect(observations.join(" ")).not.toContain("changed");
      expect(observations[1]).not.toBe("policy");
      expect(result.steps[0]).toMatchObject({ id: "work", status });
      expect(JSON.stringify(result.errors)).not.toContain("changed");
    }
  );
});
