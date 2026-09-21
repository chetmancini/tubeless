import { describe, expect, it } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineHooks,
  type PipelineStepProgress,
  type PipelineStepStatus,
} from "./pipeline.js";

function emitFocused(hooks: PipelineHooks, event: PipelineStepStatus): void {
  switch (event.status) {
    case "planned":
      hooks.onStepPlan?.(event);
      break;
    case "running":
      if (event.progress)
        hooks.onStepProgress?.({ ...event, progress: structuredClone(event.progress) });
      else hooks.onStepStart?.({ ...event, progress: undefined });
      break;
    case "completed":
      hooks.onStepComplete?.({ ...event });
      break;
    case "skipped":
      hooks.onStepSkip?.({ ...event });
      break;
    case "cancelled":
      hooks.onStepCancel?.({ ...event });
      break;
    case "failed":
      hooks.onStepFail?.({ ...event });
      break;
  }
}

describe.each(["single", "mapped"] as const)("external %s child progress", (kind) => {
  it.each(["completed", "skipped", "failed", "cancelled"] as const)(
    "preserves live and %s details through either hook family without duplicate updates",
    async (status) => {
      const observed: PipelineStepProgress[][] = [];
      for (const mode of ["compiled", "focused", "canonical", "canonical-first", "focused-first"]) {
        const controller = new AbortController();
        const { step, fromPipeline, forEachPipeline } = createSteps();
        const child = definePipeline({
          id: "child",
          steps: [
            step("filtered", { run: () => 0 }),
            step("work", {
              skip: () => status === "skipped" && "nothing to do",
              run: (_, context) => {
                const progress: PipelineStepProgress = {
                  completed: 1,
                  total: 2,
                  message: "half",
                  details: [
                    {
                      id: "record",
                      name: "Record",
                      depth: 1,
                      completed: 1,
                      total: 2,
                      status: "running",
                      label: "reading",
                    },
                  ],
                };
                context.reportProgress(progress);
                // A change confined to a detail row must remain observable.
                context.reportProgress({
                  ...progress,
                  details: [{ ...progress.details![0]!, label: "writing" }],
                });
                if (status === "failed") throw new Error("work failed");
                if (status === "cancelled") {
                  controller.abort();
                  const error = new Error("stopped");
                  error.name = "AbortError";
                  throw error;
                }
                return 1;
              },
            }),
          ],
        });
        const external: typeof child = {
          ...child,
          run(options, controls, context) {
            const hooks = Array.isArray(context?.hooks) ? context.hooks : [context?.hooks];
            return child.run(options, controls, {
              ...context,
              hooks: {
                onStepStatus(event) {
                  for (const hook of hooks) {
                    if (!hook) continue;
                    if (mode === "focused" || mode === "focused-first") emitFocused(hook, event);
                    if (mode !== "focused") hook.onStepStatus?.(event);
                    if (mode === "canonical-first") emitFocused(hook, event);
                  }
                },
              },
            });
          },
        };
        const config = {
          pipeline: mode === "compiled" ? child : external,
          controls: { stepIds: ["work"] as const },
          mapOptions: () => ({}),
        };
        const parent = definePipeline({
          id: "parent",
          steps: [
            kind === "single"
              ? fromPipeline("child", config)
              : forEachPipeline("child", { ...config, items: () => ["item"], key: (key) => key }),
          ],
        });
        const snapshots: PipelineStepProgress[] = [];
        await parent.run({}, undefined, {
          signal: controller.signal,
          log: { log() {}, warn() {}, error() {} },
          hooks: { onStepProgress: ({ progress }) => snapshots.push(progress) },
        });
        expect(snapshots.at(-1)).toMatchObject({ completed: 1, total: 1 });
        expect(snapshots.at(-1)?.details).toContainEqual(
          expect.objectContaining({ id: "work", status })
        );
        expect(
          snapshots.every(({ details }) => !details?.some(({ id }) => id === "filtered"))
        ).toBe(true);
        if (status !== "skipped") {
          expect(
            snapshots.some(({ details }) =>
              details?.some((row) => row.id === "record" && row.label === "reading")
            )
          ).toBe(true);
          expect(
            snapshots.some(({ details }) =>
              details?.some((row) => row.id === "record" && row.label === "writing")
            )
          ).toBe(true);
          expect(
            snapshots.some(({ details }) =>
              details?.some(
                (row) =>
                  row.id === "work" &&
                  row.status === "running" &&
                  row.completed === 1 &&
                  row.total === 2
              )
            )
          ).toBe(true);
        }
        observed.push(snapshots);
      }
      for (const snapshots of observed.slice(1)) expect(snapshots).toEqual(observed[0]);
    }
  );
});
