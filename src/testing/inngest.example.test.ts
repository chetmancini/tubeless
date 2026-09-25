import { InngestTestEngine, mockCtx } from "@inngest/test";
import { createSteps, definePipeline, requireOutputs } from "tubeless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../../examples/inngest/client.js";
import { normalizeFunction } from "../../examples/inngest/functions.js";
import { InngestPipeline } from "../../examples/inngest/pipeline.js";

afterEach(() => vi.restoreAllMocks());

const job = { lines: [" Alpha ", "", "Beta", "ALPHA"] };

function environment(data: unknown = job, attempt = 0) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  vi.spyOn(inngest.logger, "info").mockImplementation(logger.info);
  vi.spyOn(inngest.logger, "warn").mockImplementation(logger.warn);
  vi.spyOn(inngest.logger, "error").mockImplementation(logger.error);
  const engine = new InngestTestEngine({
    function: normalizeFunction,
    transformCtx: (ctx) => ({
      ...mockCtx(ctx),
      event: { ...ctx.event, name: "tubeless/normalize.requested", data },
      runId: "inngest-run-1",
      attempt,
    }),
  });
  return { engine, logger };
}

describe("Inngest durable step recipe", () => {
  it("runs the pipeline inside step.run with correlated progress and traces", async () => {
    const { engine, logger } = environment({ ...job, parentRunId: "parent:execution-1" });
    const execute = vi.spyOn(InngestPipeline, "runOrThrow");
    const { result, error, ctx } = await engine.execute();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ rows: ["alpha", "beta"], count: 2, preview: false });
    expect(result).toMatchObject({ runId: expect.stringMatching(/^inngest-normalize:/) });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.step.run).toHaveBeenCalledWith("run-pipeline", expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(
      "Tubeless progress",
      expect.objectContaining({ stepId: "normalize", completed: 4, total: 4 })
    );
    expect(logger.info).toHaveBeenCalledWith("Tubeless event", {
      event: expect.objectContaining({
        name: "pipeline.started",
        runId: expect.stringMatching(/^inngest-normalize:/),
        parentRunId: "parent:execution-1",
        correlationId: JSON.stringify(["inngest", "inngest-run-1", "run-pipeline"]),
      }),
    });
    expect(logger.info).toHaveBeenCalledWith("Tubeless event", {
      event: expect.objectContaining({ name: "pipeline.completed" }),
    });
  });

  it("returns mocked durable step output without starting another pipeline", async () => {
    const { engine } = environment();
    const { result: saved } = await engine.executeStep("run-pipeline");
    const execute = vi.spyOn(InngestPipeline, "runOrThrow");
    // The test engine supplies mocked state; this does not test service persistence.
    const { result } = await engine.execute({
      steps: [{ id: "run-pipeline", handler: () => saved }],
    });
    expect(result).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards dry-run controls without inventing a Tubeless parent", async () => {
    const { engine, logger } = environment({ ...job, dryRun: true });
    const { result } = await engine.execute();
    expect(result).toMatchObject({ preview: true });
    const start = logger.info.mock.calls.find(
      ([message, metadata]) =>
        message === "Tubeless event" && metadata.event.name === "pipeline.started"
    );
    expect(start?.[1].event).not.toHaveProperty("parentRunId");
  });

  it.each([
    null,
    {},
    { lines: [42] },
    { lines: [], dryRun: "true" },
    { lines: [], parentRunId: "" },
  ])("rejects invalid event data %j before Tubeless wraps the error", async (data) => {
    const { engine } = environment(data);
    const execute = vi.spyOn(InngestPipeline, "runOrThrow");
    const { error } = await engine.executeStep("run-pipeline");
    expect(error).toMatchObject({ name: "NonRetriableError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reruns completed domain work after a later handler fails", async () => {
    // Substitute a real two-step pipeline with controllable domain I/O at the
    // host boundary. The sample pipeline itself has only pure transformations.
    const { step } = createSteps<{ lines: readonly string[] }>();
    const loadRows = vi.fn(() => ["alpha", "beta"]);
    const saveRows = vi
      .fn(async (rows: string[]) => rows)
      .mockRejectedValueOnce(new Error("Temporary storage failure"));
    const load = step("load", { run: loadRows });
    const save = step("save", {
      dependsOn: [load],
      dryRun: "skip",
      run: ({ load }) => saveRows(load),
    });
    const pipeline = definePipeline({
      id: "retry-fixture",
      steps: [load, save],
      finalize: requireOutputs([save], ({ save }, context) => ({
        rows: save,
        count: save.length,
        runId: context.runId,
        preview: context.dryRun,
      })),
    });
    vi.spyOn(InngestPipeline, "runOrThrow").mockImplementation((options, controls, context) =>
      pipeline.runOrThrow(options, { dryRun: controls?.dryRun }, context)
    );

    const first = environment();
    const { error } = await first.engine.executeStep("run-pipeline");
    expect(error).toMatchObject({ name: "PipelineExecutionError" });
    expect(loadRows).toHaveBeenCalledTimes(1);
    expect(saveRows).toHaveBeenCalledTimes(1);
    expect(first.logger.info).toHaveBeenCalledWith("Tubeless event", {
      event: expect.objectContaining({ name: "step.failed", stepId: "save" }),
    });

    const second = environment(job, 1);
    const { result } = await second.engine.execute();
    expect(result).toMatchObject({ rows: ["alpha", "beta"] });
    expect(loadRows).toHaveBeenCalledTimes(2);
    expect(saveRows).toHaveBeenCalledTimes(2);
    expect(saveRows).toHaveBeenNthCalledWith(1, ["alpha", "beta"]);
    expect(saveRows).toHaveBeenNthCalledWith(2, ["alpha", "beta"]);
    const start = (logger: typeof first.logger) =>
      logger.info.mock.calls.find(
        ([message, metadata]) =>
          message === "Tubeless event" && metadata.event.name === "pipeline.started"
      )?.[1].event;
    expect(start(first.logger).correlationId).toBe(start(second.logger).correlationId);
    expect(result).not.toMatchObject({ runId: start(first.logger).runId });
  });
});
