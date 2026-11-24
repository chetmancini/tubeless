import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineStepProgress } from "./pipeline.js";

describe("mapped child adapter: planning and progress", () => {
  it("plans each mapped child once per item", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "mapped-once-child",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const planSpy = vi.spyOn(child, "plan");
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "a" }, { id: "b" }],
      key: (item) => item.id,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "mapped-once-parent",
      steps: [children],
      finalize: (outputs) => outputs.children,
    });

    const result = await parent.run({});

    expect(result.status).toBe("completed");
    expect(result.value).toEqual(["done", "done"]);
    expect(planSpy).toHaveBeenCalledTimes(2);
  });

  it("does not count filtered child steps toward fan-out progress", async () => {
    interface ChildOptions {
      itemId: string;
    }

    const { step: childStep } = createSteps<ChildOptions>();
    let processStarted = false;
    const setup = childStep("setup", {
      run: () => "setup",
    });
    const process = childStep("process", {
      run: (_inputs, context) => {
        processStarted = true;
        return context.options.itemId;
      },
    });
    const child = definePipeline({
      id: "filtered-child",
      steps: [setup, process],
      finalize: (outputs) => outputs.process ?? outputs.setup,
    });

    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "only" }],
      key: (item) => item.id,
      controls: { stepIds: ["process"] },
      mapOptions: (item) => ({ itemId: item.id }),
    });
    const parent = definePipeline({
      id: "filtered-parent",
      steps: [children],
      finalize: (outputs) => outputs.children,
    });

    const progress: PipelineStepProgress[] = [];
    let sawFullBeforeProcess = false;
    const result = await parent.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepProgress: ({ progress: next, step }) => {
          if (step.id !== "children") return;
          progress.push({
            completed: next.completed,
            total: next.total,
            message: next.message,
          });
          if (!processStarted && next.total === 1 && next.completed >= 1) {
            sawFullBeforeProcess = true;
          }
        },
      },
      log: console,
    });

    expect(result.status).toBe("completed");
    expect(processStarted).toBe(true);
    expect(progress.some((p) => p.total === 1)).toBe(true);
    expect(sawFullBeforeProcess).toBe(false);
    expect(progress.at(-1)).toMatchObject({ completed: 1, total: 1 });
  });

  it("uses the exact selected-step total when mapped items choose different child plans", async () => {
    interface ChildOptions {
      itemId: string;
    }
    const { step: childStep } = createSteps<ChildOptions>();
    const prepare = childStep("prepare", {
      run: (_inputs, context) => `prepared:${context.options.itemId}`,
    });
    const process = childStep("process", {
      dependsOn: [prepare],
      run: (_inputs, context) => `processed:${context.options.itemId}`,
    });
    const child = definePipeline({
      id: "mixed-plan-child",
      steps: [prepare, process],
      finalize: (outputs) => outputs.process ?? outputs.prepare,
    });

    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [
        { id: "prepare-only", stepIds: ["prepare"] as const },
        { id: "full", stepIds: ["prepare", "process"] as const },
      ],
      key: (item) => item.id,
      controls: (item) => ({ stepIds: item.stepIds }),
      mapOptions: (item) => ({ itemId: item.id }),
    });
    const parent = definePipeline({
      id: "mixed-plan-parent",
      steps: [children],
      finalize: (outputs) => outputs.children,
    });
    const progress: Array<{ completed: number; total?: number }> = [];

    const result = await parent.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepProgress: ({ progress: next, step }) => {
          if (step.id === "children") {
            progress.push({ completed: next.completed, total: next.total });
          }
        },
      },
      log: console,
    });

    expect(result.status).toBe("completed");
    expect(progress.at(-1)).toEqual({ completed: 3, total: 3 });
    expect(progress.some(({ total }) => total === 4)).toBe(false);
    let previousRatio = 0;
    for (const next of progress) {
      if (next.total === undefined || next.total === 0) continue;
      const ratio = next.completed / next.total;
      expect(ratio).toBeGreaterThanOrEqual(previousRatio);
      previousRatio = ratio;
    }
  });

  it("does not re-publish mapped progress from empty child progress snapshots", async () => {
    let publishChildProgress: ((progress: PipelineStepProgress) => void) | undefined;
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const { step: childStep } = createSteps();
    const work = childStep("work", {
      run: async (_inputs, context) => {
        publishChildProgress = context.reportProgress;
        context.reportProgress({ completed: 1, total: 2, message: "chunk" });
        await workGate;
        return "done";
      },
    });
    const child = definePipeline({
      id: "mapped-empty-progress-child",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "only" }],
      key: (item) => item.id,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "mapped-empty-progress-parent",
      steps: [children],
      finalize: (outputs) => outputs.children,
    });
    let visibleFanoutPublishes = 0;
    let zeroProgressLabels = 0;
    const runPromise = parent.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepProgress: ({ progress, step }) => {
          if (step.id !== "children") return;
          if (!progress.message && progress.total === undefined) return;
          visibleFanoutPublishes += 1;
          const labels = [
            progress.message ?? "",
            ...(progress.details ?? []).map((detail) => detail.label ?? ""),
          ];
          if (labels.some((label) => /work:0\b/.test(label) || label.endsWith(":0"))) {
            zeroProgressLabels += 1;
          }
        },
      },
      log: console,
    });
    try {
      await vi.waitFor(() => {
        expect(publishChildProgress).toBeTypeOf("function");
      });
      const beforeEmptyProgress = visibleFanoutPublishes;
      publishChildProgress!({ completed: 0 });
      expect(visibleFanoutPublishes).toBe(beforeEmptyProgress);
      expect(zeroProgressLabels).toBe(0);
    } finally {
      releaseWork();
    }
    const result = await runPromise;

    expect(result.status).toBe("completed");
    expect(zeroProgressLabels).toBe(0);
  });

  it("rejects duplicate item keys before starting children", async () => {
    const runChild = vi.fn();
    const { step: childStep } = createSteps();
    const process = childStep("process", { run: runChild });
    const child = definePipeline({
      id: "keyed-child",
      steps: [process],
      finalize: () => true,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "same" }, { id: "same" }],
      key: (item) => item.id,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "keyed-parent",
      steps: [children],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(result.status).not.toBe("completed");
    expect(result.errors[0]?.message).toContain("duplicate item keys: same");
    expect(runChild).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects static fan-out concurrency %s when the step is created",
    (concurrency) => {
      const { step: childStep } = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({ id: "bounded-child", steps: [work], finalize: work });
      const { forEachPipeline: parentForEachPipeline } = createSteps();
      const build = () =>
        parentForEachPipeline("children", {
          pipeline: child,
          items: () => [1],
          key: String,
          concurrency,
          mapOptions: () => ({}),
        });

      expect(build).toThrow(RangeError);
      expect(build).toThrow(/forEachPipeline concurrency must be a positive finite integer/);
    }
  );

  it("rejects a dynamically resolved invalid concurrency before running any child", async () => {
    const runChild = vi.fn();
    const { step: childStep } = createSteps();
    const work = childStep("work", { run: runChild });
    const child = definePipeline({ id: "bounded-child", steps: [work], finalize: work });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [],
      key: String,
      concurrency: () => 0,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "dynamic-parent",
      steps: [children],
      finalize: children,
    });

    const result = await parent.run({});

    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toContain(
      "Mapped child pipeline bounded-child concurrency must be a positive finite integer, got 0"
    );
    expect(runChild).not.toHaveBeenCalled();
  });
});
