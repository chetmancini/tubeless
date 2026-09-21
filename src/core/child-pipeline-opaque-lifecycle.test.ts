import { describe, expect, it, vi } from "vitest";
import { createPipelineReporter } from "../reporter/interactive-reporter.js";
import { createSteps, definePipeline } from "./pipeline.js";
import { captureOutput } from "./child-pipeline.test-support.js";

describe("opaque child adapter: lifecycle", () => {
  it("applies a child pipeline's declared target closure through controls", async () => {
    const ran: string[] = [];
    const { step: childStep } = createSteps();
    const load = childStep("load", { run: () => (ran.push("load"), "loaded") });
    const publish = childStep("publish", {
      dependsOn: [load],
      run: ({ load }) => (ran.push("publish"), `${load}:published`),
    });
    const child = definePipeline({
      id: "targeted-child",
      steps: [load, publish],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const controls = vi.fn(() => ({ targets: ["publish"] as const }));
    const stage = parentFromPipeline("targeted-stage", {
      pipeline: child,
      controls,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "targeted-parent",
      steps: [stage],
      finalize: (outputs) => outputs["targeted-stage"],
    });

    await expect(parent.runOrThrow({})).resolves.toBe("loaded:published");
    expect(controls).toHaveBeenCalledOnce();
    expect(ran).toEqual(["load", "publish"]);
  });

  it("keeps the interactive reporter active until the parent completes", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: console,
      mode: "interactive",
      output,
      refreshIntervalMs: 10_000,
      symbols: "ascii",
      terminal: { color: false, isTTY: true, unicode: false },
    });
    const { step: childStep } = createSteps();
    const inside = childStep("inside", { run: () => "child result" });
    const child = definePipeline({
      id: "reporter-child",
      steps: [inside],
      finalize: (outputs) => outputs.inside,
    });
    const { step: parentStep, fromPipeline: parentFromPipeline } = createSteps();
    const childStage = parentFromPipeline("child-stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const afterChild = parentStep("after-child", {
      dependsOn: [childStage],
      run: () => "parent result",
    });
    const parent = definePipeline({
      id: "reporter-parent",
      steps: [childStage, afterChild],
      finalize: (outputs) => outputs["after-child"],
    });
    let renderedAfterChild = "";
    let renderedAfterParent = "";

    await parent.run({}, undefined, {
      cwd: "/tmp",
      hooks: [
        reporter.hooks,
        {
          onPipelineComplete: () => {
            renderedAfterParent = output.chunks.join("");
          },
          onStepComplete: ({ step }) => {
            if (step.id === "child-stage") {
              renderedAfterChild = output.chunks.join("");
            }
          },
        },
      ],
      log: reporter.log,
    });

    expect(renderedAfterChild).not.toContain("\u001B[?25h");
    expect(renderedAfterChild).not.toContain("Pipeline reporter-child: done");
    expect(renderedAfterParent).toContain("Pipeline reporter-parent: done");
    expect(renderedAfterParent.match(/\u001B\[\?25h/g)).toHaveLength(1);
  });

  it("does not enter child work when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runChild = vi.fn();
    const { step: childStep } = createSteps();
    const inside = childStep("inside", { run: runChild });
    const child = definePipeline({
      id: "already-aborted-child",
      steps: [inside],
      finalize: () => true,
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const childStage = parentFromPipeline("child-stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "already-aborted-parent",
      steps: [childStage],
      finalize: () => true,
    });

    const result = await parent.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });

    expect(result.status).not.toBe("completed");
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      message: expect.stringMatching(/operation was aborted/i),
      phase: "execution",
      stepId: "child-stage",
    });
    expect(runChild).not.toHaveBeenCalled();
  });

  it("passes later parent cancellation into in-flight child work", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sleep = vi.fn(
      (_durationMs: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );
    const { step: childStep } = createSteps();
    const wait = childStep("wait", {
      run: async (_inputs, context) => {
        expect(context.signal).toBe(controller.signal);
        markStarted?.();
        await context.sleep(1, context.signal);
      },
    });
    const child = definePipeline({ id: "abort-child", steps: [wait], finalize: () => true });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("abort-stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({ id: "abort-parent", steps: [stage], finalize: () => true });

    const resultPromise = parent.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
      sleep,
    });
    await started;
    controller.abort(new Error("sleep interrupted"));
    const result = await resultPromise;

    expect(result.status).not.toBe("completed");
    expect(result.errors[0]?.message).toBe(
      "Child pipeline abort-child failed at wait: sleep interrupted"
    );
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      phase: "execution",
      stepId: "abort-stage",
    });
    expect(sleep).toHaveBeenCalledWith(1, controller.signal);
  });
});
