import { expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineExecutionJournal } from "./pipeline.js";
import { retainedJournal } from "./execution-journal.test-support.js";
import { inMemoryCheckpointStore } from "../utilities/checkpoint-store.js";

const version = { implementationVersion: "1" };
const quiet = { log() {}, warn() {}, error() {} };
const context = (executionJournal: PipelineExecutionJournal, signal?: AbortSignal) => ({
  executionJournal,
  signal,
  log: quiet,
});

it("re-enters nested wrappers and waiting input while restoring completed sibling effects", async () => {
  const records = new Map<string, Buffer>();
  const effect = vi.fn(() => 7);
  const read = vi.fn((_inputs, ctx) => {
    expect(ctx.executionJournalPath).toContain("review");
    if (!answered) {
      abort.abort();
      throw abort.signal.reason;
    }
    return "approved";
  });
  let answered = false;
  const abort = new AbortController();
  function pipeline() {
    const { step, waitForInput, fromPipeline } = createSteps();
    const child = definePipeline({
      id: "child",
      ...version,
      steps: [step("effect", { run: effect }), waitForInput("review", { read })],
    });
    const middle = definePipeline({
      id: "middle",
      ...version,
      steps: [fromPipeline("child", { pipeline: child })],
    });
    return definePipeline({
      id: "root",
      ...version,
      steps: [fromPipeline("middle", { pipeline: middle })],
    });
  }
  expect(
    (await pipeline().run({}, {}, context(retainedJournal(records), abort.signal))).status
  ).toBe("cancelled");
  answered = true;
  expect(await pipeline().runOrThrow({}, {}, context(retainedJournal(records)))).toBe("approved");
  expect(effect).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(2);
});

it("reconstructs keyed fan-out with distinct logical identities and rejects a changed item manifest", async () => {
  const records = new Map<string, Buffer>();
  const effects = vi.fn((_inputs, ctx) => ctx.options.item);
  const paths: string[] = [];
  const abort = new AbortController();
  let answered = false;
  let items = ["a/b", "iteration-1", ""];
  function pipeline() {
    const { step, waitForInput } = createSteps<{ item: string }>();
    const work = step("effect", { run: effects });
    const wait = waitForInput("wait", {
      dependsOn: [work],
      read: ({ effect }, ctx) => {
        paths.push(JSON.stringify(ctx.executionJournalPath));
        if (effect === "iteration-1" && !answered) {
          abort.abort();
          throw abort.signal.reason;
        }
        return effect;
      },
    });
    const child = definePipeline({ id: "same-child", ...version, steps: [work, wait] });
    const { forEachPipeline } = createSteps();
    return definePipeline({
      id: "fan-out",
      ...version,
      steps: [
        forEachPipeline("items", {
          pipeline: child,
          items: () => items,
          key: (item) => item,
          mapOptions: (item) => ({ item }),
          concurrency: 1,
        }),
      ],
    });
  }
  expect(
    (await pipeline().run({}, {}, context(retainedJournal(records), abort.signal))).status
  ).toBe("cancelled");
  const before = effects.mock.calls.length;
  items = ["a/b", "iteration-1", "new"];
  const changed = await pipeline().run({}, {}, context(retainedJournal(records)));
  expect(JSON.stringify(changed.errors)).toContain("HOST_CONFLICT");
  expect(effects).toHaveBeenCalledTimes(before);
  items = ["a/b", "iteration-1", ""];
  answered = true;
  expect(await pipeline().runOrThrow({}, {}, context(retainedJournal(records)))).toEqual(items);
  expect(effects.mock.calls.map((call) => call[1].options.item)).toEqual(items);
  expect(new Set(paths).size).toBe(3);
});

it("rebuilds iteration state with saved child outputs instead of repeating acknowledged page effects", async () => {
  const records = new Map<string, Buffer>();
  const abort = new AbortController();
  let ready = false;
  const effects = vi.fn((_inputs, ctx) => ctx.options.page);
  function pipeline() {
    const { step, waitForInput } = createSteps<{ page: number }>();
    const work = step("work", { run: effects });
    const child = definePipeline({
      id: "page",
      ...version,
      steps: [
        work,
        waitForInput("wait", {
          dependsOn: [work],
          read: ({ work }) => {
            if (work === 2 && !ready) {
              abort.abort();
              throw abort.signal.reason;
            }
            return work;
          },
        }),
      ],
    });
    const { iteratePipeline } = createSteps();
    const loop = iteratePipeline("pages", {
      pipeline: child,
      maxIterations: 3,
      initialState: () => 1,
      mapOptions: (page) => ({ page }),
      transition: (page) =>
        page === 3 ? { kind: "finish", result: page } : { kind: "next", state: page! + 1 },
    });
    return definePipeline({ id: "pages", ...version, steps: [loop] });
  }
  await pipeline().run({}, {}, context(retainedJournal(records), abort.signal));
  ready = true;
  expect(await pipeline().runOrThrow({}, {}, context(retainedJournal(records)))).toBe(3);
  expect(effects.mock.calls.map((call) => call[1].options.page)).toEqual([1, 2, 3]);
});

it("rejects opaque child implementations before dispatch when recovery is enabled", async () => {
  const { step, fromPipeline } = createSteps();
  const child = definePipeline({
    id: "opaque",
    ...version,
    steps: [step("effect", { run: () => 1 })],
  });
  const run = vi.fn(child.run);
  const opaque = { ...child, run };
  const parent = definePipeline({
    id: "parent",
    ...version,
    steps: [fromPipeline("child", { pipeline: opaque })],
  });
  const result = await parent.run({}, { continueOnError: true }, context(retainedJournal()));
  expect(JSON.stringify(result.errors)).toContain("TUBELESS_JOURNAL_UNSUPPORTED_CHILD");
  expect(run).not.toHaveBeenCalled();
  expect(await parent.runOrThrow()).toBe(1);
});

it("does not collect a child journal failure or dispatch more items", async () => {
  const effect = vi.fn(() => 1);
  const later = vi.fn(() => 2);
  const { step, forEachPipeline } = createSteps();
  const child = definePipeline({
    id: "child",
    ...version,
    steps: [step("effect", { run: effect })],
  });
  const pipeline = definePipeline({
    id: "collect",
    ...version,
    steps: [
      forEachPipeline("children", {
        pipeline: child,
        items: () => ["a", "b", "c"],
        key: (item) => item,
        mapOptions: () => ({}),
        onItemFailure: "collect",
      }),
      step("later", { run: later }),
    ],
  });
  const host = retainedJournal();
  const result = await pipeline.run(
    {},
    { continueOnError: true },
    context({
      ...host,
      complete: async (path, value) => {
        if (path.includes("effect"))
          throw Object.assign(new Error("storage offline"), { code: "HOST_OFFLINE" });
        await host.complete(path, value);
      },
    })
  );
  expect(result.status).toBe("failed");
  expect(JSON.stringify(result.errors)).toContain("HOST_OFFLINE");
  expect(effect).toHaveBeenCalledTimes(1);
  expect(later).not.toHaveBeenCalled();
});

it("drains concurrent effects and retains successful sibling acknowledgements after another journal write fails", async () => {
  const records = new Map<string, Buffer>();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed = vi.fn();
  const { step } = createSteps();
  const pipeline = definePipeline({
    id: "drain",
    ...version,
    steps: [
      step("fail", { run: () => 1 }),
      step("active", {
        run: async () => {
          await pending;
          return 2;
        },
      }),
      step("unstarted", { run: () => 3 }),
    ],
  });
  const host = retainedJournal(records);
  const result = await pipeline.run(
    {},
    { maxConcurrency: 2, continueOnError: true },
    {
      ...context({
        ...host,
        complete: async (path, value) => {
          if (path.at(-1) === "fail") {
            release();
            throw new Error("write failed");
          }
          await host.complete(path, value);
          completed(path.at(-1));
        },
      }),
    }
  );
  expect(result.status).toBe("failed");
  expect(completed.mock.calls).toEqual([["active"]]);
  expect(result.steps.find((step) => step.id === "unstarted")?.status).toBe("skipped");
});

it("keeps child-only dry runs and item checkpoints separate from the journal", async () => {
  const paths: string[][] = [];
  const checkpoint = inMemoryCheckpointStore();
  const host = retainedJournal();
  const seen = vi.fn((ctx) => {
    expect(ctx.executionJournal).toBeUndefined();
    expect(ctx.executionJournalPath).toBeUndefined();
    ctx.checkpoint.record("preview");
    ctx.checkpoint.flush();
    return 1;
  });
  const { step, fromPipeline } = createSteps();
  const child = definePipeline({
    id: "preview-child",
    steps: [step("preview", { dryRun: (_inputs, ctx) => seen(ctx), run: () => 0 })],
  });
  const pipeline = definePipeline({
    id: "preview-parent",
    ...version,
    steps: [fromPipeline("child", { pipeline: child, controls: { dryRun: true } })],
  });
  expect(
    await pipeline.runOrThrow(
      {},
      {},
      {
        ...context({
          ...host,
          bind: async (path, value) => {
            paths.push([...path]);
            await host.bind(path, value);
          },
        }),
        checkpoint,
      }
    )
  ).toBe(1);
  expect(paths.some((path) => path.includes("preview-child"))).toBe(false);
  expect(seen).toHaveBeenCalledTimes(1);
  expect(checkpoint.has("preview")).toBe(false);
});

it.each(["begin", "complete"] as const)(
  "preserves journal failure when cancellation races with %s",
  async (operation) => {
    const abort = new AbortController();
    const { step } = createSteps();
    const effect = vi.fn(() => 1);
    const pipeline = definePipeline({
      id: "abort-race",
      ...version,
      steps: [step("effect", { run: effect })],
    });
    const failure = Object.assign(new Error("fence revoked"), { code: "HOST_FENCE" });
    const result = await pipeline.run(
      {},
      {},
      context(
        {
          ...retainedJournal(),
          [operation]: async () => {
            abort.abort();
            throw failure;
          },
        },
        abort.signal
      )
    );
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.sourceCode).toBe("HOST_FENCE");
    expect(effect).toHaveBeenCalledTimes(operation === "complete" ? 1 : 0);
  }
);

it("does not start a handler when cancellation arrives during acknowledged begin", async () => {
  const abort = new AbortController();
  const host = retainedJournal();
  const effect = vi.fn(() => 1);
  const { step } = createSteps();
  const pipeline = definePipeline({
    id: "abort-begin",
    ...version,
    steps: [step("work", { run: effect })],
  });
  const result = await pipeline.run(
    {},
    {},
    context(
      {
        ...host,
        begin: async (...args) => {
          const result = await host.begin(...args);
          abort.abort();
          return result;
        },
      },
      abort.signal
    )
  );
  expect(result.status).toBe("cancelled");
  expect(effect).not.toHaveBeenCalled();
});
