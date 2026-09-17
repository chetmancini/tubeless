import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";
import { defaultPipelineContext } from "./pipeline-execute.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

describe("opaque child adapter: failures and planning", () => {
  it("fails one opaque step with child-identifying details and skips parent finalization", async () => {
    const { step: childStep } = createSteps();
    const explode = childStep("explode", {
      run: () => {
        throw new Error("database unavailable");
      },
    });
    const child = definePipeline({
      id: "failing-child",
      steps: [explode],
      finalize: () => "unreachable",
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("child-stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parentFinalize = vi.fn(() => "parent-result");
    const parent = definePipeline({
      id: "failure-parent",
      steps: [stage],
      finalize: parentFinalize,
    });

    const result = await parent.run({});

    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      id: "child-stage",
      status: "failed",
      error: {
        code: "TUBELESS_CHILD_FAILED",
        kind: "child",
        message: "Child pipeline failing-child failed at explode: database unavailable",
        phase: "execution",
        stepId: "child-stage",
      },
    });
    expect(result.steps[0]).toMatchObject({ status: "failed", error: result.errors[0] });
    expect(parentFinalize).not.toHaveBeenCalled();
  });

  it("fails the parent when a continuing child contains errors", async () => {
    const { step: childStep } = createSteps();
    const fail = childStep("fail", {
      run: () => {
        throw new Error("expected failure");
      },
    });
    const recover = childStep("recover", { run: () => "recovered" });
    const child = definePipeline({
      id: "continuing-child",
      steps: [fail, recover],
      finalize: (outputs) => outputs.recover,
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("continuing-stage", {
      pipeline: child,
      mapOptions: () => ({ continueOnError: true }),
    });
    const parent = definePipeline({
      id: "continuing-parent",
      steps: [stage],
      finalize: (outputs) => outputs["continuing-stage"],
    });

    const result = await parent.run({});

    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(false);
    expect(result.errors[0]?.message).toContain(
      "Child pipeline continuing-child failed at fail: expected failure"
    );
  });

  it("preserves a child pipeline's cause chain on the opaque parent error", async () => {
    const rootCause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const childError = new Error("request failed", { cause: rootCause });
    const { step: childStep } = createSteps();
    const fail = childStep("fail", {
      run: () => {
        throw childError;
      },
    });
    const child = definePipeline({
      id: "causal-child",
      steps: [fail],
      finalize: () => undefined,
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("causal-stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "causal-parent",
      steps: [stage],
      finalize: () => undefined,
    });

    const result = await parent.run({});

    expect(result.errors[0]).toMatchObject({
      cause: {
        cause: {
          message: "socket closed",
          sourceCode: "ECONNRESET",
        },
        message: "request failed",
      },
      code: "TUBELESS_CHILD_FAILED",
      kind: "child",
      stepId: "causal-stage",
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("rejects an invalid child plan before child execution starts", async () => {
    const runChild = vi.fn();
    const { step: childStep } = createSteps();
    const known = childStep("known", { run: runChild });
    const child = definePipeline({ id: "planned-child", steps: [known], finalize: () => true });
    const runSpy = vi.spyOn(child, "run");
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("planned-stage", {
      pipeline: child,
      mapOptions: () => ({ stepIds: ["missing" as never] }),
    });
    const parent = definePipeline({ id: "planned-parent", steps: [stage], finalize: () => true });

    const result = await parent.run({});

    expect(result.status).not.toBe("completed");
    expect(runChild).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.errors[0]?.message).toContain("Child pipeline planned-child could not start");
    expect(result.errors[0]?.message).toContain("unknown step ids: missing");
  });

  it("plans a nested child once before execution", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "once-child",
      steps: [work],
      finalize: () => true,
    });
    const planSpy = vi.spyOn(child, "plan");
    const runSpy = vi.spyOn(child, "run");
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "once-parent",
      steps: [stage],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(result.status).toBe("completed");
    expect(result.value).toBe(true);
    expect(planSpy).toHaveBeenCalledOnce();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("runs a public Pipeline child that lacks the compiled execute binding", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "spread-child",
      steps: [work],
      finalize: () => "child-ok" as const,
    });
    const publicChild = { ...child };
    const runSpy = vi.spyOn(publicChild, "run");
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("stage", {
      pipeline: publicChild,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "spread-parent",
      steps: [stage],
      finalize: (outputs) => outputs.stage,
    });

    const result = await parent.run({});

    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.value).toBe("child-ok");
    expect(runSpy).toHaveBeenCalledOnce();
  });

  it("uses public run on an Object.create wrapper that overrides run", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "proto-child",
      steps: [work],
      finalize: () => "child-ok" as const,
    });
    const runSpy = vi.fn(child.run.bind(child));
    const decorated = Object.create(child, {
      run: { configurable: true, enumerable: true, value: runSpy, writable: true },
    }) as typeof child;
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("stage", {
      pipeline: decorated,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "proto-parent",
      steps: [stage],
      finalize: (outputs) => outputs.stage,
    });

    const result = await parent.run({});

    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.value).toBe("child-ok");
    expect(runSpy).toHaveBeenCalledOnce();
  });

  it("does not invoke public run when a child plan is already invalid", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "invalid-spread-child",
      steps: [work],
      finalize: () => true,
    });
    const publicChild = { ...child };
    const runSpy = vi.spyOn(publicChild, "run");
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("stage", {
      pipeline: publicChild,
      mapOptions: () => ({ stepIds: ["missing" as never] }),
    });
    const parent = definePipeline({
      id: "invalid-spread-parent",
      steps: [stage],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(result.status).not.toBe("completed");
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.errors[0]?.message).toContain("could not start");
    expect(result.errors[0]?.message).toContain("unknown step ids: missing");
  });

  it("emits child lifecycle traces when a public child plan is already invalid", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "invalid-trace-child",
      steps: [work],
      finalize: () => true,
    });
    const publicChild = { ...child };
    const runSpy = vi.spyOn(publicChild, "run");
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("stage", {
      pipeline: publicChild,
      mapOptions: () => ({ stepIds: ["missing" as never] }),
    });
    const parent = definePipeline({
      id: "invalid-trace-parent",
      steps: [stage],
      finalize: () => true,
    });
    const events: PipelineTraceEvent[] = [];
    const result = await parent.run({}, undefined, {
      ...defaultPipelineContext(),
      correlationId: "parent-job",
      tracing: { exporter: { export: (event) => void events.push(event) } },
    });

    expect(result.status).not.toBe("completed");
    expect(runSpy).not.toHaveBeenCalled();
    expect(
      events.find(
        (event) => event.name === "pipeline.started" && event.pipelineId === "invalid-trace-child"
      )
    ).toMatchObject({ parentRunId: result.runId, payload: { planOk: false } });
    expect(
      events.find(
        (event) => event.name === "pipeline.completed" && event.pipelineId === "invalid-trace-child"
      )
    ).toMatchObject({ correlationId: "parent-job", parentRunId: result.runId });
  });
});
