import { describe, expect, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineContext,
  type PipelineStepProgress,
  type PipelineStepStatus,
} from "./pipeline.js";
import { createPipelineReporter } from "../reporter/interactive-reporter.js";
import { createMappedChildProgress, createSingleChildProgress } from "./child-progress.js";

const log = { log() {}, warn() {}, error() {} };

describe("canonical child progress projection", () => {
  const { step } = createSteps();
  const child = definePipeline({
    id: "child",
    steps: [
      step("filtered", { run: () => 0 }),
      step("work", { name: "Work", run: () => 1 }),
      step("save", { run: () => 2 }),
    ],
  });
  const plan = child.plan({ stepIds: ["work", "save"] });
  const work = plan.steps.find(({ id }) => id === "work")!;
  const filtered: PipelineStepStatus = {
    pipelineId: child.id,
    step: plan.steps.find(({ id }) => id === "filtered")!,
    id: "filtered",
    status: "skipped",
    reason: "filtered",
    finishedAtMs: 0,
  };
  const running: PipelineStepStatus = {
    pipelineId: child.id,
    step: work,
    status: "running",
    attemptId: "attempt",
  };
  const complete: PipelineStepStatus = {
    ...running,
    id: work.id,
    status: "completed",
    startedAtMs: 0,
    finishedAtMs: 1,
  };

  it("keeps provenance changes when reconciling focused and status hooks", () => {
    const snapshots: PipelineStepProgress[] = [];
    const hooks = createSingleChildProgress(plan, (progress) => snapshots.push(progress));
    hooks.onStepStatus!(running);
    hooks.onStepStart!({ ...running, progress: undefined, outputSource: "override" });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)?.details).toContainEqual(
      expect.objectContaining({ id: "work", status: "running", outputSource: "override" })
    );
    const progress: PipelineStepProgress = {
      completed: 1,
      details: [{ id: "nested", status: "completed" }],
    };
    hooks.onStepStatus!({ ...running, progress });
    hooks.onStepProgress!({
      ...running,
      progress: {
        ...progress,
        details: [{ id: "nested", status: "completed", outputSource: "override" }],
      },
    });
    expect(snapshots).toHaveLength(4);
    expect(snapshots.at(-1)?.details).toContainEqual(
      expect.objectContaining({ id: "nested", status: "completed", outputSource: "override" })
    );
    hooks.onStepComplete!({ ...complete, outputSource: "override" });
    expect(snapshots.at(-1)).toMatchObject({ completed: 1 });
    expect(snapshots.at(-1)?.details).toContainEqual(
      expect.objectContaining({ id: "work", status: "completed", outputSource: "override" })
    );
  });

  it.each(["single", "mapped"] as const)(
    "%s consumes each status once and counts selected terminal steps once",
    (kind) => {
      const snapshots: PipelineStepProgress[] = [];
      const report = (progress: PipelineStepProgress) => snapshots.push(progress);
      const hooks =
        kind === "single"
          ? createSingleChildProgress(plan, report)
          : createMappedChildProgress(["item"], 1, { sampleLimit: 1 }, report).plan("item", plan);
      hooks.onStepStatus!({ pipelineId: child.id, step: work, status: "planned" });
      hooks.onStepStatus!({ ...running, progress: { completed: 0 } });
      expect(snapshots).toHaveLength(0);
      hooks.onStepStatus!(filtered);
      expect(snapshots).toHaveLength(kind === "single" ? 1 : 0);
      if (kind === "single") expect(snapshots.at(-1)?.completed).toBe(0);
      snapshots.length = 0;

      hooks.onStepStatus!(running);
      expect(snapshots).toHaveLength(1);
      hooks.onStepStatus!({
        ...running,
        progress: {
          completed: 2,
          total: 3,
          details: [{ id: "record", status: "running" }],
        },
      });
      expect(snapshots).toHaveLength(2);
      expect(snapshots.at(-1)?.message).toContain(
        kind === "single" ? "Work: 2 completed" : "Work:2/3"
      );
      hooks.onStepStatus!({ ...running, progress: { completed: 0 } });
      expect(snapshots).toHaveLength(2);
      hooks.onStepStatus!(complete);
      hooks.onStepStatus!(complete);
      expect(snapshots).toHaveLength(4);
      expect(snapshots.at(-1)).toMatchObject({ completed: 1, total: 2 });
      expect(snapshots.at(-1)?.details).toContainEqual(
        expect.objectContaining({ id: "work", status: "completed", completed: 2, total: 3 })
      );
      expect(snapshots.at(-1)?.details).toContainEqual(
        expect.objectContaining({
          id: "record",
          status: "completed",
          depth: kind === "single" ? 1 : 2,
        })
      );
      expect(snapshots.at(-1)?.details?.some(({ id }) => id === "filtered")).toBe(false);
      expect(snapshots[1]?.details).toContainEqual(
        expect.objectContaining({ id: "record", status: "running" })
      );
    }
  );

  it.each(["single", "mapped"] as const)(
    "%s keeps distinct detail updates when hook families alternate",
    (kind) => {
      const snapshots: PipelineStepProgress[] = [];
      const report = (progress: PipelineStepProgress) => snapshots.push(progress);
      const hooks =
        kind === "single"
          ? createSingleChildProgress(plan, report)
          : createMappedChildProgress(["item"], 1, undefined, report).plan("item", plan);
      const progress: PipelineStepProgress = {
        completed: 1,
        total: 2,
        details: [{ id: "record", label: "reading" }],
      };
      hooks.onStepStatus!({ ...running, progress });
      const changed = {
        ...running,
        progress: { ...progress, details: [{ id: "record", label: "writing" }] },
      };
      hooks.onStepProgress!(changed);
      expect(snapshots).toHaveLength(2);
      // Pair the focused update with an equivalent canonical copy.
      hooks.onStepStatus!(structuredClone(changed));
      expect(snapshots).toHaveLength(2);
      expect(snapshots.at(-1)?.details).toContainEqual(
        expect.objectContaining({ id: "record", label: "writing" })
      );
    }
  );

  it("reconciles missing terminal statuses before an item result mapping fails", () => {
    const snapshots: PipelineStepProgress[] = [];
    const progress = createMappedChildProgress(["item"], 1, undefined, (next) =>
      snapshots.push(next)
    );
    progress.start("item");
    const hooks = progress.plan("item", plan);
    hooks.onStepStatus!(complete);
    progress.childCompleted("item");
    progress.childCompleted("item");
    // A duplicate terminal event after reconciliation still cannot advance the count.
    hooks.onStepStatus!(complete);
    expect(snapshots.at(-1)).toMatchObject({ completed: 2, total: 2 });
    progress.fail("item", new Error("mapping failed"), false);
    expect(snapshots.at(-1)).toMatchObject({ completed: 2, total: 2 });
    expect(snapshots.at(-1)?.details?.[0]).toEqual({
      id: "item",
      status: "failed",
      label: "mapping failed",
    });
  });
});

describe("nested child progress", () => {
  describe.each(["single", "mapped"] as const)("%s wrapper observation", (kind) => {
    it.each(["none", "completion", "progress", "status", "tracing"] as const)(
      "only materializes nested trees for progress observers (%s)",
      async (observer) => {
        let detailReads = 0;
        const detail = {
          get id() {
            detailReads += 1;
            return "record";
          },
          status: "completed" as const,
        };
        const { step, fromPipeline, forEachPipeline } = createSteps();
        const leaf = definePipeline({
          id: "leaf",
          steps: Array.from({ length: 16 }, (_, index) =>
            step(`work-${index}`, {
              run: (_, context) => {
                for (let completed = 1; completed <= 4; completed += 1) {
                  context.reportProgress({ completed, total: 4, details: [detail] });
                }
                return 1;
              },
            })
          ),
          finalize: () => 1,
        });
        const middle = definePipeline({
          id: "middle",
          steps: [fromPipeline("nested", { pipeline: leaf, mapOptions: () => ({}) })],
          finalize: () => 1,
        });
        const work =
          kind === "single"
            ? fromPipeline("work", { pipeline: middle, mapOptions: () => ({}) })
            : forEachPipeline("work", {
                pipeline: middle,
                items: () => ["a"],
                key: (key) => key,
                mapOptions: () => ({}),
              });
        const root = definePipeline({ id: "root", steps: [work], finalize: () => 1 });
        const runtime: Partial<PipelineContext> = { log };
        const snapshots: PipelineStepProgress[] = [];
        const recorded: string[] = [];
        const onComplete = vi.fn();
        if (observer === "completion") runtime.hooks = { onPipelineComplete: onComplete };
        if (observer === "progress")
          runtime.hooks = [{ onStepProgress: ({ progress }) => snapshots.push(progress) }];
        if (observer === "status")
          runtime.hooks = {
            onStepStatus: (event) => {
              if (event.status === "running" && event.progress) snapshots.push(event.progress);
            },
          };
        if (observer === "tracing")
          runtime.tracing = {
            exporter: {
              export: (event) => {
                if (
                  event.pipelineId === "root" &&
                  event.name === "step.running" &&
                  event.payload.progress?.details
                ) {
                  recorded.push(JSON.stringify(event.payload.progress.details));
                }
              },
            },
          };
        expect((await root.run({}, undefined, runtime)).value).toBe(1);
        if (observer === "none" || observer === "completion") {
          expect(detailReads).toBe(0);
          if (observer === "completion") expect(onComplete).toHaveBeenCalledOnce();
        } else {
          expect(detailReads).toBeGreaterThan(0);
          if (observer === "tracing") expect(recorded.at(-1)).toContain("work-15");
          else
            expect(snapshots.at(-1)?.details).toContainEqual(
              expect.objectContaining({ id: "work-15", status: "completed" })
            );
        }
      }
    );
  });

  it.each([undefined, 8])(
    "bounds live fan-out materialization with detailLimit %s",
    async (detailLimit) => {
      const count = 512;
      const { step, forEachPipeline } = createSteps();
      const child = definePipeline({
        id: "child",
        steps: [
          step("work", {
            run: (_, context) => {
              context.reportProgress({ completed: 1, total: 2 });
              return 1;
            },
          }),
        ],
        finalize: () => 1,
      });
      const parent = definePipeline({
        id: "parent",
        steps: [
          forEachPipeline("items", {
            pipeline: child,
            items: () => Array.from({ length: count }, (_, index) => index),
            key: String,
            concurrency: 4,
            mapOptions: () => ({}),
            progress: { detailLimit },
          }),
        ],
        finalize: () => 1,
      });
      const snapshots: PipelineStepProgress[] = [];
      await parent.run({}, undefined, {
        log,
        hooks: {
          onStepProgress: ({ progress }) => snapshots.push(progress),
        },
      });
      const liveLimit = detailLimit ?? 32;
      expect(
        Math.max(...snapshots.slice(0, -1).map(({ details }) => details?.length ?? 0))
      ).toBeLessThanOrEqual(2 * liveLimit + 1);
      // Guard total allocation growth without relying on noisy wall-clock timings.
      expect(snapshots.reduce((sum, { details }) => sum + (details?.length ?? 0), 0)).toBeLessThan(
        count * 400
      );
      expect(snapshots[0]?.details?.[0]).toMatchObject({ id: "0", status: "pending" });
      const final = snapshots.at(-1)?.details ?? [];
      expect(final.filter((row) => !row.depth && row.status === "completed")).toHaveLength(
        detailLimit ?? count
      );
      if (detailLimit === undefined) {
        expect(final).toHaveLength(count * 2);
        expect(final.at(-2)?.id).toBe(String(count - 1));
      } else {
        expect(final.at(-1)?.id).toBe(`+${count - detailLimit} more`);
      }
    }
  );

  it("does not construct fan-out progress payloads when nothing observes progress", async () => {
    const { step, forEachPipeline } = createSteps();
    const child = definePipeline({
      id: "child",
      steps: [step("work", { run: () => 1 })],
      finalize: () => 1,
    });
    const formatMessage = vi.fn(() => "items");
    const parent = definePipeline({
      id: "parent",
      steps: [
        forEachPipeline("items", {
          pipeline: child,
          items: () => ["a", "b"],
          key: (key) => key,
          mapOptions: () => ({}),
          progress: { formatMessage },
        }),
      ],
      finalize: () => 1,
    });
    await parent.run({}, undefined, { log });
    expect(formatMessage).not.toHaveBeenCalled();
    await parent.run({}, undefined, { log, hooks: { onStepProgress() {} } });
    expect(formatMessage).toHaveBeenCalled();
  });

  it.each([undefined, 8, 3])(
    "keeps a three-level tree and completed rows with terminal height %s",
    async (rows) => {
      const { step, fromPipeline, forEachPipeline } = createSteps();
      const read = step("read", {
        name: "Read records",
        run: (_inputs, context) => {
          context.reportProgress({ completed: 2, total: 4, message: "records" });
          return 2;
        },
      });
      const write = step("write", { dependsOn: [read], run: () => 1 });
      const leaf = definePipeline({ id: "leaf", steps: [read, write], finalize: () => 1 });
      const middle = definePipeline({
        id: "middle",
        steps: [fromPipeline("build", { pipeline: leaf, mapOptions: () => ({}) })],
        finalize: () => 1,
      });
      const batch = definePipeline({
        id: "batch",
        steps: [
          forEachPipeline("editions", {
            pipeline: middle,
            items: () => ["a", "b"],
            key: (key) => key,
            concurrency: 2,
            mapOptions: () => ({}),
          }),
        ],
        finalize: () => 1,
      });
      const root = definePipeline({
        id: "root",
        steps: [fromPipeline("library", { pipeline: batch, mapOptions: () => ({}) })],
        finalize: () => 1,
      });
      const chunks: string[] = [];
      const reporter = createPipelineReporter({
        log,
        mode: "interactive",
        color: "never",
        symbols: "unicode",
        refreshIntervalMs: 10_000,
        output: { columns: 140, rows, isTTY: true, write: (chunk) => chunks.push(chunk) },
      });
      const snapshots: PipelineStepProgress[] = [];
      const pipelineIds = new Set<string>();
      await root.run({}, undefined, {
        cwd: "/tmp",
        log: reporter.log,
        hooks: [
          reporter.hooks,
          {
            onStepProgress: ({ progress, pipelineId }) => {
              snapshots.push(progress);
              pipelineIds.add(pipelineId);
            },
          },
        ],
      });
      reporter.dispose();
      expect([...pipelineIds]).toEqual(["root"]);
      expect(
        snapshots.some(({ details }) =>
          details?.some(
            (row) =>
              row.id === "read" &&
              row.status === "running" &&
              row.completed === 2 &&
              row.total === 4
          )
        )
      ).toBe(true);
      expect(
        snapshots.at(-1)?.details?.map(({ id, depth, status }) => [id, depth ?? 0, status])
      ).toEqual([
        ["editions", 0, "completed"],
        ["a", 1, "completed"],
        ["build", 2, "completed"],
        ["read", 3, "completed"],
        ["write", 3, "completed"],
        ["b", 1, "completed"],
        ["build", 2, "completed"],
        ["read", 3, "completed"],
        ["write", 3, "completed"],
      ]);
      const finalFrame = chunks
        .join("")
        .split(/\u001B\[\d+F\u001B\[J/)
        .at(-1)!;
      expect(finalFrame).toContain("    ✓ editions");
      expect(finalFrame).toContain("      ✓ a");
      expect(finalFrame).toContain("        ✓ build");
      expect(finalFrame).toContain("          ✓ Read records records");
      expect(finalFrame).toContain("50% 2/4");
      expect(finalFrame).toContain("          ✓ write");
      if (rows !== undefined) {
        const output = chunks.join("");
        expect(output).toMatch(/rows (above|below|omitted)/);
        const erasedRows = [...output.matchAll(/\u001B\[(\d+)F/g)].map((match) => Number(match[1]));
        expect(Math.max(...erasedRows)).toBeLessThan(rows);
        expect(output).not.toContain("\u0001");
      }
    }
  );

  it.each(["failed", "cancelled", "skipped"] as const)(
    "retains %s children and excludes filtered steps",
    async (status) => {
      const { step, fromPipeline } = createSteps();
      const controller = new AbortController();
      const work = step("work", {
        dryRun: "skip",
        run: () => {
          if (status === "cancelled") {
            controller.abort();
            const error = new Error("stopped");
            error.name = "AbortError";
            throw error;
          }
          throw new Error("stopped");
        },
      });
      const filtered = step("filtered", { run: () => 1 });
      const child = definePipeline({ id: "child", steps: [work, filtered], finalize: () => 1 });
      const root = definePipeline({
        id: "root",
        steps: [
          fromPipeline("child", {
            pipeline: child,
            controls: { stepIds: ["work"] },
            mapOptions: () => ({}),
          }),
        ],
        finalize: () => 1,
      });
      const snapshots: PipelineStepProgress[] = [];
      await root.run(
        {},
        { dryRun: status === "skipped" },
        {
          cwd: "/tmp",
          log,
          signal: controller.signal,
          hooks: { onStepProgress: ({ progress }) => snapshots.push(progress) },
        }
      );
      expect(snapshots.at(-1)?.details).toEqual([expect.objectContaining({ id: "work", status })]);
    }
  );

  it("prioritizes active item groups under a detail limit and keeps failures after settlement", async () => {
    const { step } = createSteps<{ key: string }>();
    const child = definePipeline({
      id: "child",
      steps: [
        step("work", {
          run: (_inputs, context) => {
            if (context.options.key === "b") throw new Error("bad edition");
            return 1;
          },
        }),
      ],
      finalize: () => 1,
    });
    const { forEachPipeline } = createSteps();
    const parent = definePipeline({
      id: "parent",
      steps: [
        forEachPipeline("editions", {
          pipeline: child,
          items: () => ["a", "b"],
          key: (key) => key,
          mapOptions: (key) => ({ key }),
          concurrency: 1,
          progress: { detailLimit: 1 },
        }),
      ],
      finalize: () => 1,
    });
    const snapshots: PipelineStepProgress[] = [];
    await parent.run({}, undefined, {
      cwd: "/tmp",
      log,
      hooks: { onStepProgress: ({ progress }) => snapshots.push(progress) },
    });
    expect(
      snapshots.some(({ details }) =>
        details?.some((row) => row.id === "b" && row.status === "running")
      )
    ).toBe(true);
    expect(
      snapshots.some(({ details }) =>
        details?.some((row) => row.id === "work" && row.status === "failed")
      )
    ).toBe(true);
    expect(snapshots.at(-1)?.details?.[0]).toMatchObject({ id: "b", status: "failed" });
    expect(snapshots.at(-1)?.details?.at(-1)?.id).toBe("+1 more");
  });
});
