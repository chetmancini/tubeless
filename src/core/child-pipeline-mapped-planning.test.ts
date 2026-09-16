import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineStepProgress } from "./pipeline.js";

describe("mapped child adapter: planning and progress", () => {
  it("plans each mapped child once per item", async () => {
    const childStep = createSteps();
    const work = childStep("work", { run: () => "done" });
    const child = definePipeline({
      id: "mapped-once-child",
      steps: [work],
      finalize: () => true,
    });
    const planSpy = vi.spyOn(child, "plan");
    const runSpy = vi.spyOn(child, "run");
    const parentStep = createSteps();
    const children = parentStep.forEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "a" }, { id: "b" }],
      key: (item) => item.id,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "mapped-once-parent",
      steps: [children],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(result.status).toBe("completed");
    expect(planSpy).toHaveBeenCalledTimes(2);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("does not count filtered child steps toward fan-out progress", async () => {
    interface ChildOptions {
      itemId: string;
    }

    const childStep = createSteps<ChildOptions>();
    let processStarted = false;
    // Independent steps so filtering "setup" does not unmet-dependency "process".
    const setup = childStep("setup", {
      run: () => "setup",
    });
    const process = childStep("process", {
      run: async (_inputs, context) => {
        processStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return context.options.itemId;
      },
    });
    const child = definePipeline({
      id: "filtered-child",
      steps: [setup, process],
      finalize: (outputs) => outputs.process ?? outputs.setup,
    });

    const parentStep = createSteps();
    const children = parentStep.forEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "only" }],
      key: (item) => item.id,
      // Select only process so setup is filtered out at the child plan.
      mapOptions: (item) => ({ itemId: item.id, stepIds: ["process"] as const }),
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
    // Denominator is selected work only (process).
    expect(progress.some((p) => p.total === 1)).toBe(true);
    // Filtered setup must not advance completed before process runs.
    expect(sawFullBeforeProcess).toBe(false);
    expect(progress.at(-1)).toMatchObject({ completed: 1, total: 1 });
  });

  it("uses the exact selected-step total when mapped items choose different child plans", async () => {
    interface ChildOptions {
      itemId: string;
    }
    const childStep = createSteps<ChildOptions>();
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

    const parentStep = createSteps();
    const children = parentStep.forEachPipeline("children", {
      pipeline: child,
      items: () => [
        { id: "prepare-only", stepIds: ["prepare"] as const },
        { id: "full", stepIds: ["prepare", "process"] as const },
      ],
      key: (item) => item.id,
      mapOptions: (item) => ({ itemId: item.id, stepIds: item.stepIds }),
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
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const childStep = createSteps();
    const work = childStep("work", {
      run: async (_inputs, context) => {
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
    const parentStep = createSteps();
    const children = parentStep.forEachPipeline("children", {
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
          // Empty snapshots have no total/message; ignore those.
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
    await vi.waitFor(() => {
      expect(visibleFanoutPublishes).toBeGreaterThan(0);
    });
    // Hold mapped children across the old 250ms observation window so a late
    // empty-progress tick would still be recorded before we release the gate.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(zeroProgressLabels).toBe(0);
    releaseWork();
    const result = await runPromise;

    expect(result.status).toBe("completed");
    // Real child progress + lifecycle updates only — not empty-progress spam.
    expect(visibleFanoutPublishes).toBeLessThan(15);
    expect(zeroProgressLabels).toBe(0);
  });

  it("rejects duplicate item keys before starting children", async () => {
    const runChild = vi.fn();
    const childStep = createSteps();
    const process = childStep("process", { run: runChild });
    const child = definePipeline({
      id: "keyed-child",
      steps: [process],
      finalize: () => true,
    });
    const parentStep = createSteps();
    const children = parentStep.forEachPipeline("children", {
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
});
