import { defer } from "../core/child-pipeline.test-support.js";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineLogger } from "../core/pipeline.js";
import { defaultPipelineContext } from "../core/pipeline-execute.js";
import { composeTraceExporters, type PipelineTraceEvent } from "./tracing.js";

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
  it("exposes event-specific payload contracts through the name discriminant", () => {
    expectTypeOf<
      Extract<PipelineTraceEvent, { name: "pipeline.started" }>["payload"]["targetIds"]
    >().toEqualTypeOf<readonly string[]>();
    expectTypeOf<
      NonNullable<
        Extract<PipelineTraceEvent, { name: "step.planned" }>["payload"]["nestedPipeline"]
      >["stepIds"]
    >().toEqualTypeOf<readonly string[]>();
    expectTypeOf<
      NonNullable<
        Extract<PipelineTraceEvent, { name: "step.running" }>["payload"]["progress"]
      >["details"]
    >().toMatchTypeOf<readonly { id: string }[] | undefined>();
  });

  it("composes exporters while retiring failed destinations", async () => {
    const event = {
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "composed",
      runId: "run-1",
      timestampMs: 1,
      version: 2,
    } satisfies PipelineTraceEvent;
    const first = { export: vi.fn(), flush: vi.fn() };
    const failed = {
      export: vi.fn().mockRejectedValue(new Error("destination failed")),
      flush: vi.fn(),
    };
    const composite = composeTraceExporters([first, failed]);

    await expect(composite.export(event)).rejects.toThrow("destination failed");
    await composite.export(event);
    await composite.flush?.();

    expect(first.export).toHaveBeenCalledTimes(2);
    expect(first.flush).toHaveBeenCalledOnce();
    expect(failed.export).toHaveBeenCalledOnce();
    expect(failed.flush).not.toHaveBeenCalled();
  });

  it.each(["export", "flush"] as const)(
    "overlaps independent %s destinations and drains them before reporting failure",
    async (operation) => {
      const gate = defer();
      const failure = new Error("destination failed");
      const slow = vi.fn(() => gate.promise);
      const fast = vi.fn(() => {
        throw failure;
      });
      const composite = composeTraceExporters([
        { export: slow, flush: slow },
        { export: fast, flush: fast },
      ]);
      const event = {
        name: "pipeline.started",
        payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        pipelineId: "composed",
        runId: "run-1",
        timestampMs: 1,
        version: 2,
      } satisfies PipelineTraceEvent;
      let settled = false;
      const result = (
        operation === "export" ? composite.export(event) : composite.flush?.()
      ) as Promise<void>;
      const assertion = expect(result).rejects.toThrow("destination failed");
      void result.then(
        () => (settled = true),
        () => (settled = true)
      );
      expect(slow).toHaveBeenCalledOnce();
      expect(fast).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      gate.resolve();
      await assertion;
      expect(settled).toBe(true);
    }
  );

  it("selects composition failures by destination order rather than completion order", async () => {
    const gate = defer();
    const firstFailure = new Error("first destination");
    const lastFailure = new Error("last destination");
    const composite = composeTraceExporters([
      {
        export: async () => {
          await gate.promise;
          throw firstFailure;
        },
      },
      { export: () => Promise.reject(lastFailure) },
    ]);
    const event = {
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "composed",
      runId: "run-1",
      timestampMs: 1,
      version: 2,
    } satisfies PipelineTraceEvent;
    const assertion = expect(composite.export(event)).rejects.toBe(firstFailure);
    gate.resolve();
    await assertion;
    await expect(composite.export(event)).rejects.toBe(lastFailure);
  });

  it.each([false, true])(
    "serializes duplicate destinations and honors retirement (failure: %s)",
    async (fail) => {
      const gate = defer();
      const destination = {
        export: vi.fn(async () => {
          await gate.promise;
          if (fail) throw new Error("retired");
        }),
      };
      const composite = composeTraceExporters([destination, destination]);
      const event = {
        name: "pipeline.started",
        payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        pipelineId: "composed",
        runId: "run-1",
        timestampMs: 1,
        version: 2,
      } satisfies PipelineTraceEvent;
      const result = composite.export(event);
      const assertion = fail
        ? expect(result).rejects.toThrow("retired")
        : expect(result).resolves.toBeUndefined();
      expect(destination.export).toHaveBeenCalledOnce();
      gate.resolve();
      await assertion;
      expect(destination.export).toHaveBeenCalledTimes(fail ? 1 : 2);
    }
  );

  it("reports a partial composition failure while continuing healthy destinations", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-partial-composition",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const events: PipelineTraceEvent[] = [];
    const failure = new Error("secondary unavailable");
    const failed = { export: vi.fn().mockRejectedValue(failure) };
    const onExporterError = vi.fn();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      correlationId: "partial-composition",
      tracing: {
        exporter: composeTraceExporters([{ export: (event) => void events.push(event) }, failed]),
        onExporterError,
      },
    });

    expect(result.status).toBe("completed");
    expect(failed.export).toHaveBeenCalledOnce();
    expect(onExporterError).toHaveBeenCalledOnce();
    expect(onExporterError).toHaveBeenCalledWith(failure);
    expect(events.map(({ name }) => name)).toEqual([
      "pipeline.started",
      "step.planned",
      "step.running",
      "step.complete",
      "pipeline.finalize.started",
      "pipeline.finalize.completed",
      "pipeline.completed",
    ]);
  });

  it("reports failure when every composed exporter is retired", async () => {
    const failure = new Error("destination failed");
    const composite = composeTraceExporters([
      { export: vi.fn().mockRejectedValue(failure) },
      { export: vi.fn().mockRejectedValue(new Error("also failed")) },
    ]);
    const event = {
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "composed",
      runId: "run-1",
      timestampMs: 1,
      version: 2,
    } satisfies PipelineTraceEvent;

    await expect(composite.export(event)).rejects.toBe(failure);
    await expect(composite.export(event)).rejects.toBeInstanceOf(Error);
  });

  it("exports ordered lifecycle events with correlation, attempt, duration, and error data", async () => {
    const { step } = createSteps();
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

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      now: () => timestamp++,
      parentRunId: "parent-1",
      correlationId: "job-1",
      tracing: {
        exporter: { export: (event) => void events.push(event), flush },
        itemKey: "chapter-3",
      },
    });

    expect(result.status).not.toBe("completed");
    expect(result.correlationId).toBe("job-1");
    expect(result.runId).toMatch(/^traced:/);
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
    expect(events.every((event) => event.runId === result.runId)).toBe(true);
    expect(events.every((event) => event.correlationId === "job-1")).toBe(true);
    expect(events.every((event) => event.parentRunId === "parent-1")).toBe(true);
    expect(events.every((event) => event.itemKey === "chapter-3")).toBe(true);
    expect(events.find((event) => event.name === "step.attempted")).toMatchObject({
      attemptId: result.steps.find(({ id }) => id === "succeed")?.attemptId,
      payload: { attempt: 2, attributes: { provider: "test" } },
      stepId: "succeed",
    });
    const runningEvents = events.filter((event) => event.name === "step.running");
    expect(runningEvents[0]?.payload).not.toHaveProperty("progress.details");
    expect(runningEvents.find((event) => event.payload.progress?.completed === 1)?.payload).toEqual(
      {
        progress: {
          completed: 1,
          detailCount: 1,
          details: [{ id: "source", label: "prepared", status: "running" }],
          message: "prepared",
          total: 2,
        },
      }
    );
    expect(events.find((event) => event.name === "pipeline.log")).toMatchObject({
      attemptId: result.steps.find(({ id }) => id === "succeed")?.attemptId,
      payload: { level: "log", message: "normalized 12" },
      stepId: "succeed",
    });
    expect(events.find((event) => event.name === "step.planned")).toMatchObject({
      payload: {
        dependencies: [],
        dryRun: "run",
        optionalDependencies: [],
        runtimeSkipPossible: false,
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
      payload: {
        dependencyId: "fail",
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

  it.each([
    ["null-prototype record", () => Object.create(null)],
    [
      "throwing coercion",
      () => ({
        [Symbol.toPrimitive]() {
          throw new Error("coercion failed");
        },
      }),
    ],
    [
      "throwing message getter",
      () =>
        Object.defineProperty(new Error(), "message", {
          get() {
            throw new Error("message failed");
          },
        }),
    ],
    [
      "throwing proxy traps",
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("get failed");
            },
            has() {
              throw new Error("has failed");
            },
            getOwnPropertyDescriptor() {
              throw new Error("descriptor failed");
            },
          }
        ),
    ],
  ])("isolates an unprintable final-event failure: %s", async (_label, createFailure) => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-unprintable",
      steps: [step("work", { run: () => 42 })],
    });
    const failure = createFailure();
    const log = createLogger();
    const onExporterError = vi.fn();
    const result = await pipeline.run({}, undefined, {
      log,
      tracing: {
        exporter: {
          export(event) {
            if (event.name === "pipeline.completed") throw failure;
          },
        },
        onExporterError,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe(42);
    expect(log.warnings).toEqual([expect.stringContaining("[unprintable error]")]);
    expect(onExporterError).toHaveBeenCalledOnce();
    expect(onExporterError.mock.calls[0]![0]).toBe(failure);
  });

  it("isolates an unprintable flush failure", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-unprintable-flush",
      steps: [step("work", { run: () => 42 })],
    });
    const failure = Object.create(null);
    const log = createLogger();
    const onExporterError = vi.fn();
    const result = await pipeline.run({}, undefined, {
      log,
      tracing: {
        exporter: {
          export() {},
          flush() {
            throw failure;
          },
        },
        onExporterError,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe(42);
    expect(log.warnings).toEqual([expect.stringContaining("flush failed: [unprintable error]")]);
    expect(onExporterError).toHaveBeenCalledOnce();
    expect(onExporterError.mock.calls[0]![0]).toBe(failure);
  });

  it.each([false, true])(
    "isolates an unprintable callback failure (async: %s)",
    async (asyncCallback) => {
      const { step } = createSteps();
      const pipeline = definePipeline({
        id: "trace-unprintable-callback",
        steps: [step("work", { run: () => 42 })],
      });
      const failure = Object.create(null);
      const log = createLogger();
      const onExporterError = vi.fn(() => {
        if (asyncCallback) return Promise.reject(failure);
        throw failure;
      });
      const result = await pipeline.run({}, undefined, {
        log,
        tracing: {
          exporter: {
            export() {
              throw new Error("collector unavailable");
            },
          },
          onExporterError,
        },
      });
      expect(result.status).toBe("completed");
      expect(result.value).toBe(42);
      expect(onExporterError).toHaveBeenCalledOnce();
      expect(log.warnings).toContain("Pipeline trace onExporterError failed: [unprintable error]");
    }
  );

  it("keeps healthy exporters after an unprintable partial failure", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-unprintable-partial",
      steps: [step("work", { run: () => 42 })],
    });
    const failure = Object.create(null);
    const events: PipelineTraceEvent[] = [];
    const failed = {
      export: vi.fn(() => {
        throw failure;
      }),
    };
    const onExporterError = vi.fn();
    const log = createLogger();
    const result = await pipeline.run({}, undefined, {
      log,
      tracing: {
        exporter: composeTraceExporters([
          failed,
          {
            export: (event) => {
              events.push(event);
            },
          },
        ]),
        onExporterError,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe(42);
    expect(failed.export).toHaveBeenCalledOnce();
    expect(onExporterError).toHaveBeenCalledOnce();
    expect(onExporterError.mock.calls[0]![0]).toBe(failure);
    expect(events.at(-1)?.name).toBe("pipeline.completed");
    expect(log.warnings).toEqual([
      expect.stringContaining("healthy exporters continue: [unprintable error]"),
    ]);
  });

  it("isolates exporter failures and still completes the pipeline", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-isolation",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const log = createLogger();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log,
      correlationId: "isolated",
      tracing: {
        exporter: {
          export: () => Promise.reject(new Error("collector unavailable")),
          flush: () => Promise.reject(new Error("flush unavailable")),
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(log.warnings).toContain(
      "Pipeline trace exporter failed; further trace events for this run will be dropped: collector unavailable"
    );
    expect(log.warnings.filter((warning) => warning.includes("flush unavailable"))).toHaveLength(0);
  });

  it("calls onExporterError once when export rejects for every event", async () => {
    const { step } = createSteps();
    const first = step("first", { run: () => "a" });
    const second = step("second", { dependsOn: [first], run: () => "b" });
    const third = step("third", { dependsOn: [second], run: () => "c" });
    const pipeline = definePipeline({
      id: "trace-export-once",
      steps: [first, second, third],
      finalize: () => "ok",
    });
    const log = createLogger();
    const exportError = new Error("collector unavailable");
    const onExporterError = vi.fn();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log,
      correlationId: "export-once",
      tracing: {
        exporter: { export: () => Promise.reject(exportError) },
        onExporterError,
      },
    });

    expect(result.status).toBe("completed");
    expect(onExporterError).toHaveBeenCalledTimes(1);
    expect(onExporterError).toHaveBeenCalledWith(exportError);
    expect(
      log.warnings.filter((warning) => warning.startsWith("Pipeline trace exporter failed"))
    ).toHaveLength(1);
  });

  it("does not call export after the first exporter failure", async () => {
    const { step } = createSteps();
    const first = step("first", { run: () => "a" });
    const second = step("second", { dependsOn: [first], run: () => "b" });
    const pipeline = definePipeline({
      id: "trace-export-drop",
      steps: [first, second],
      finalize: () => "ok",
    });
    let exportCalls = 0;

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      correlationId: "export-drop",
      tracing: {
        exporter: {
          export: () => {
            exportCalls += 1;
            return Promise.reject(new Error("collector unavailable"));
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(exportCalls).toBe(1);
  });

  it("does not call onExporterError when the exporter succeeds", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-export-ok",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const onExporterError = vi.fn();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      correlationId: "export-ok",
      tracing: {
        exporter: { export: () => undefined },
        onExporterError,
      },
    });

    expect(result.status).toBe("completed");
    expect(onExporterError).not.toHaveBeenCalled();
  });

  it("calls onExporterError once when flush rejects after successful export", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-flush-once",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const log = createLogger();
    const flushError = new Error("flush unavailable");
    const onExporterError = vi.fn();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log,
      correlationId: "flush-once",
      tracing: {
        exporter: {
          export: () => undefined,
          flush: () => Promise.reject(flushError),
        },
        onExporterError,
      },
    });

    expect(result.status).toBe("completed");
    expect(onExporterError).toHaveBeenCalledTimes(1);
    expect(onExporterError).toHaveBeenCalledWith(flushError);
    expect(log.warnings).toContain("Pipeline trace exporter flush failed: flush unavailable");
  });

  it("completes the run when onExporterError throws", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-callback-throw",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const log = createLogger();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log,
      correlationId: "callback-throw",
      tracing: {
        exporter: { export: () => Promise.reject(new Error("collector unavailable")) },
        onExporterError: () => {
          throw new Error("callback exploded");
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(log.warnings).toContain("Pipeline trace onExporterError failed: callback exploded");
  });

  it("completes the run when onExporterError returns a rejected promise", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-callback-reject",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const log = createLogger();

    const result = await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log,
      correlationId: "callback-reject",
      tracing: {
        exporter: { export: () => Promise.reject(new Error("collector unavailable")) },
        onExporterError: () => Promise.reject(new Error("callback exploded")),
      },
    });

    expect(result.status).toBe("completed");
    expect(log.warnings).toContain("Pipeline trace onExporterError failed: callback exploded");
  });

  it("does not wait for a slow onExporterError before completing the run", async () => {
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "trace-callback-slow",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runPromise = pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      correlationId: "callback-slow",
      tracing: {
        exporter: { export: () => Promise.reject(new Error("collector unavailable")) },
        onExporterError: () => hung,
      },
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("run waited on onExporterError")), 100);
    });

    try {
      const result = await Promise.race([runPromise, timeout]);
      expect(result.status).toBe("completed");
    } finally {
      release();
      await runPromise;
    }
  });

  it("links child runs to the parent trace identity", async () => {
    const { step: childStep } = createSteps();
    const child = definePipeline({
      id: "trace-child",
      steps: [childStep("inside", { run: () => "child" })],
      finalize: (outputs) => outputs.inside,
    });
    const { fromPipeline } = createSteps();
    const childStage = fromPipeline("child-stage", {
      mapOptions: () => ({}),
      pipeline: child,
    });
    const parent = definePipeline({
      id: "trace-parent",
      steps: [childStage],
      finalize: (outputs) => outputs["child-stage"],
    });
    const events: PipelineTraceEvent[] = [];

    const parentRun = await parent.run({}, undefined, {
      ...defaultPipelineContext(),
      correlationId: "parent-job",
      tracing: {
        exporter: { export: (event) => void events.push(event) },
      },
    });
    expect(parentRun).toMatchObject({ correlationId: "parent-job", status: "completed" });

    expect(
      events.find(
        (event) => event.name === "pipeline.started" && event.pipelineId === "trace-child"
      )
    ).toMatchObject({ correlationId: "parent-job", parentRunId: parentRun.runId });
    expect(
      events.find((event) => event.name === "step.planned" && event.pipelineId === "trace-parent")
    ).toMatchObject({
      payload: {
        nestedPipeline: {
          mode: "single",
          pipelineId: "trace-child",
          stepCount: 1,
          stepIds: ["inside"],
        },
      },
      stepId: "child-stage",
    });
  });

  it("records remote metadata on step.planned without flattening descendant runs", async () => {
    const schema = {
      "~standard": {
        validate: () => ({ value: { ok: true as const } }),
        vendor: "test",
        version: 1 as const,
      },
    };
    const { fromRemote } = createSteps();
    const enrich = fromRemote("enrich", {
      adapter: { engine: "test", target: "enrich-v2", invoke: async () => ({ ok: true as const }) },
      mapInput: () => ({}),
      outputSchema: schema,
    });
    const pipeline = definePipeline({
      id: "trace-remote",
      steps: [enrich],
      finalize: () => undefined,
    });
    const events: PipelineTraceEvent[] = [];

    await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      correlationId: "remote-run",
      tracing: {
        exporter: { export: (event) => void events.push(event) },
      },
    });

    expect(events.filter((event) => event.name === "pipeline.started")).toHaveLength(1);
    expect(
      events.find((event) => event.name === "step.planned" && event.stepId === "enrich")
    ).toMatchObject({
      payload: { remote: { engine: "test", target: "enrich-v2" } },
      stepId: "enrich",
    });
  });

  it("adds stable mapped item keys to descendant runs", async () => {
    interface ChildOptions {
      value: string;
    }
    interface ParentOptions {
      values: readonly string[];
    }

    const { step: childStep } = createSteps<ChildOptions>();
    const child = definePipeline({
      id: "trace-mapped-child",
      steps: [childStep("inside", { run: (_inputs, context) => context.options.value })],
      finalize: (outputs) => outputs.inside ?? "",
    });
    const { forEachPipeline } = createSteps<ParentOptions>();
    const children = forEachPipeline("children", {
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

    const parentRun = await parent.run({ values: ["first", "second"] }, undefined, {
      ...defaultPipelineContext(),
      correlationId: "mapped-parent-job",
      tracing: {
        exporter: { export: (event) => void events.push(event) },
      },
    });
    expect(parentRun).toMatchObject({ status: "completed" });

    const childStarts = events.filter(
      (event) => event.name === "pipeline.started" && event.pipelineId === "trace-mapped-child"
    );
    expect(childStarts).toHaveLength(2);
    expect(childStarts.map((event) => event.itemKey).sort()).toEqual(["first", "second"]);
    expect(childStarts.every((event) => event.parentRunId === parentRun.runId)).toBe(true);
  });

  it("bounds progress details and records the original detail count", async () => {
    const { step } = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({
          completed: 1,
          details: Array.from({ length: 130 }, (_, index) => ({
            id: index === 0 ? "x".repeat(5_000) : `item-${index}`,
            label: index === 0 ? "y".repeat(5_000) : "scan",
            name: "Nested work",
            depth: 3,
            completed: 2,
            total: 5,
            status: "cancelled",
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

    await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      tracing: { exporter: { export: (event) => void events.push(event) } },
    });

    const progress = events.find(
      (event) => event.name === "step.running" && event.payload.progress?.completed === 1
    );
    if (progress?.name !== "step.running") throw new Error("missing progress trace");
    expect(progress?.payload.progress?.detailCount).toBe(130);
    const details = progress?.payload.progress?.details as
      | Array<{
          id: string;
          label?: string;
        }>
      | undefined;
    if (!details) throw new Error("missing progress details");
    expect(details).toHaveLength(128);
    expect(details[0]?.id).toHaveLength(4_096);
    expect(details[0]?.label).toHaveLength(4_096);
    expect(details[0]).toMatchObject({
      name: "Nested work",
      depth: 3,
      completed: 2,
      total: 5,
      status: "cancelled",
    });
  });

  it("keeps tracing enabled for valid identifiers longer than metadata bounds", async () => {
    const pipelineId = `pipeline-${"p".repeat(5_000)}`;
    const stepId = `step-${"s".repeat(5_000)}`;
    const { step } = createSteps();
    const work = step(stepId, { run: () => "ok" });
    const pipeline = definePipeline({
      id: pipelineId,
      steps: [work],
      targets: [work],
      finalize: () => "ok",
    });
    const events: PipelineTraceEvent[] = [];
    const log = createLogger();

    await pipeline.run(
      {},
      { targets: [stepId] },
      {
        ...defaultPipelineContext(),
        log,
        tracing: { exporter: { export: (event) => void events.push(event) } },
      }
    );

    expect(log.warnings).toEqual([]);
    expect(events.find((event) => event.name === "pipeline.started")).toMatchObject({
      payload: { targetIds: [stepId] },
      pipelineId,
    });
    expect(events.at(-1)?.name).toBe("pipeline.completed");
  });

  it("bounds validation issues before codec validation without failing the run trace", async () => {
    const optionsSchema = {
      "~standard": {
        validate: () => ({
          issues: Array.from({ length: 130 }, () => ({
            message: "m".repeat(5_000),
            path: ["p".repeat(5_000)],
          })),
        }),
        vendor: "test",
        version: 1 as const,
      },
    };
    const { step } = createSteps(optionsSchema);
    const pipeline = definePipeline({
      id: "bounded-validation-issues",
      steps: [step("work", { run: () => "never" })],
      finalize: () => undefined,
    });
    const events: PipelineTraceEvent[] = [];
    const log = createLogger();

    await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log,
      tracing: { exporter: { export: (event) => void events.push(event) } },
    });

    expect(log.warnings).toEqual([]);
    const completed = events.find((event) => event.name === "pipeline.completed");
    expect(completed?.error?.issues).toHaveLength(128);
    expect(completed?.error?.issues?.[0]?.message).toHaveLength(4_096);
    expect(completed?.error?.issues?.[0]?.path?.[0]).toHaveLength(4_096);
    expect(events.at(-1)?.name).toBe("pipeline.completed");
  });

  it("omits detail attributes when progress has no detail rows", async () => {
    const { step } = createSteps();
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

    await pipeline.run({}, undefined, {
      ...defaultPipelineContext(),
      log: createLogger(),
      tracing: { exporter: { export: (event) => void events.push(event) } },
    });

    expect(
      events.find(
        (event) => event.name === "step.running" && event.payload.progress?.completed === 1
      )?.payload
    ).toEqual({ progress: { completed: 1, message: "batches", total: 2 } });
  });
});
